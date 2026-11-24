import { test } from "node:test";
import assert from "node:assert/strict";
import { testCtx, categorieId } from "./helpers.ts";
import { autoAfletteren, haalTransactie, kandidaatAfschrijvingen, slaRekeningOp, voorstellen } from "../src/modules/bank/service.ts";
import { haalFactuur, nieuweInkoopfactuur, rekenOm, werkFactuurBij } from "../src/modules/facturen/service.ts";
import { slaRelatieOp } from "../src/modules/relaties/service.ts";

test("factuur in dollars: eerst omrekenen, dan boeken, afschrijving gevonden op factuurnummer en afgeletterd", async () => {
  const ctx = await testCtx();
  try {
    const rek = slaRekeningOp(ctx, null, { naam: "N26", iban: "DE89 3704 0044 0532 0130 00", bank: "N26", beginsaldo: 0, begindatum: "2026-01-01" }, "test");
    const lev = slaRelatieOp(ctx, null, { naam: "Acme Inc", type: "leverancier", land: "US" }, "test");
    const id = nieuweInkoopfactuur(ctx, "handmatig", { gebruiker: "test" });
    const invoer = {
      relatie_id: lev, factuurnummer: "INV-2026-77", factuurdatum: "2026-11-02", valuta: "usd",
      regels: [{ categorie_id: categorieId(ctx, "Software & abonnementen"), bedrag_excl: 10000, btw_code: "BUITEN_EU" }],
    };
    werkFactuurBij(ctx, "inkoop", id, invoer, { gebruiker: "test" });
    assert.equal(haalFactuur(ctx, "inkoop", id)!.valuta, "USD");
    // Boeken zonder omrekening mag niet
    assert.throws(() => werkFactuurBij(ctx, "inkoop", id, invoer, { gebruiker: "test", boeken: true }), /Reken hem eerst om/);

    ctx.db.run("INSERT INTO banktransacties (rekening_id, boekdatum, bedrag, valuta, tegenpartij_naam, omschrijving, fingerprint) VALUES (?, '2026-11-05', -9210, 'EUR', 'ACME INC', 'Card payment INV-2026-77', 'fp1')", [rek]);
    const f0 = haalFactuur(ctx, "inkoop", id)!;
    const kand = kandidaatAfschrijvingen(ctx, f0, { naam: "Acme Inc", iban: null });
    assert.equal(kand.length, 1);
    assert.equal(kand[0].transactie.bedrag, -9210);
    assert.ok(kand[0].redenen.includes("factuurnummer in omschrijving"));

    rekenOm(ctx, id, { bedragEur: 9210 }, "test");
    const f1 = haalFactuur(ctx, "inkoop", id)!;
    assert.equal(f1.totaal_incl, 9210);
    assert.equal(f1.bedrag_valuta, 10000);
    assert.ok(Math.abs(f1.wisselkoers! - 0.921) < 1e-9);
    // Opnieuw omrekenen met een koers rekent vanaf het origineel
    rekenOm(ctx, id, { koers: 0.9 }, "test");
    assert.equal(haalFactuur(ctx, "inkoop", id)!.totaal_incl, 9000);
    rekenOm(ctx, id, { bedragEur: 9210 }, "test");

    werkFactuurBij(ctx, "inkoop", id, { ...invoer, regels: f1.regels.map((r) => ({ categorie_id: r.categorie_id, bedrag_excl: r.bedrag_excl, btw_code: r.btw_code, btw_bedrag: r.btw_bedrag })) }, { gebruiker: "test", boeken: true });
    assert.equal(haalFactuur(ctx, "inkoop", id)!.status, "geboekt");
    assert.equal(autoAfletteren(ctx), 1);
    assert.equal(haalFactuur(ctx, "inkoop", id)!.betaalstatus, "betaald");
    assert.equal(haalTransactie(ctx, 1)!.status, "gekoppeld");
  } finally {
    ctx.opruimen();
  }
});

test("bank toont bestelnummer i.p.v. factuurnummer: koppelen op referentie uit de factuur, daarna bedrag, daarna naam", async () => {
  const ctx = await testCtx();
  try {
    const rek = slaRekeningOp(ctx, null, { naam: "N26", iban: "DE89 3704 0044 0532 0130 00", bank: "N26", beginsaldo: 0, begindatum: "2026-01-01" }, "test");
    const lev = slaRelatieOp(ctx, null, { naam: "Vimexx B.V.", type: "leverancier" }, "test");
    const maak = (nr: string, excl: number, refs: string[]) => {
      const id = nieuweInkoopfactuur(ctx, "handmatig", { gebruiker: "test" });
      werkFactuurBij(ctx, "inkoop", id, { relatie_id: lev, factuurnummer: nr, factuurdatum: "2026-08-05", regels: [{ categorie_id: categorieId(ctx, "Software & abonnementen"), bedrag_excl: excl, btw_code: "NL21" }] }, { gebruiker: "test", boeken: true });
      ctx.db.run("UPDATE inkoopfacturen SET ai_voorstel = ? WHERE id = ?", [JSON.stringify({ referenties: refs }), id]);
      return id;
    };
    const juist = maak("20262679358", 1000, ["20264844523"]);
    const anders = maak("20262716385", 1000, ["20264999999"]); // zelfde bedrag, andere bestelling
    ctx.db.run("INSERT INTO banktransacties (rekening_id, boekdatum, bedrag, valuta, tegenpartij_naam, omschrijving, fingerprint) VALUES (?, '2026-08-07', -1210, 'EUR', 'Vimexx', 'M03178654MRY9QLJ 0380986535331791 Vimexx Bestelling 20264844523', 'fp1')", [rek]);
    const t = haalTransactie(ctx, 1)!;
    const vs = voorstellen(ctx, t);
    assert.equal(vs[0].koppelingen[0].factuurId, juist);
    assert.ok(vs[0].redenen.some((r) => /bestelnummer/.test(r)));
    assert.ok(vs[1].score < vs[0].score);
    assert.equal(vs[1].koppelingen[0].factuurId, anders); // zonder nummer: bedrag + naam
    assert.equal(autoAfletteren(ctx), 1);
    assert.equal(haalFactuur(ctx, "inkoop", juist)!.betaalstatus, "betaald");
    assert.equal(haalFactuur(ctx, "inkoop", anders)!.betaalstatus, "open");
  } finally {
    ctx.opruimen();
  }
});

test("referenties uit AI: tekst met komma's, JSON-lijst en lege waarde", async () => {
  const { leesReferenties } = await import("../src/modules/bank/service.ts");
  assert.deepEqual(leesReferenties("20264844523, AB12"), ["20264844523"]);
  assert.deepEqual(leesReferenties('["20264844523"]'), ["20264844523"]);
  assert.deepEqual(leesReferenties(null), []);
});

test("zakelijk percentage per leverancier: regel gesplitst, totaal gelijk, BTW-aftrek alleen zakelijk deel", async () => {
  const { vertaalVoorstel } = await import("../src/integrations/ai/extract.ts");
  const ctx = await testCtx();
  try {
    slaRelatieOp(ctx, null, { naam: "Ziggo Zakelijk", type: "leverancier", btw_nummer: "NL810983510B01", zakelijk_pct: "50" }, "test");
    const v = vertaalVoorstel(ctx, {
      is_factuur: true,
      leverancier: { naam: "Ziggo Zakelijk", btw_nummer: "NL810983510B01", kvk: null, iban: null, email: null, adres: null, postcode: null, plaats: null, land: "NL" },
      ontvanger: null, factuurnummer: "Z1", referenties: null, factuurdatum: "2026-11-01", vervaldatum: null, valuta: "EUR", is_creditnota: false, btw_verlegd: false,
      regels: [{ omschrijving: "Internet", klant: null, periode: null, bedrag_excl: 50, btw_tarief: 21, btw_bedrag: 10.5 }],
      totaal_excl: 50, totaal_btw: 10.5, totaal_incl: 60.5, al_betaald: false, voorgestelde_categorie: "Telefoon & internet", opmerkingen: null,
    } as never);
    assert.equal(v.regels.length, 2);
    assert.equal(v.regels[0].bedrag_excl, 2500);
    assert.equal(v.regels[0].btw_bedrag, 525);
    assert.equal(v.regels[1].btw_code, "GEEN");
    assert.equal(v.regels[1].bedrag_excl, 3025);
    assert.equal(v.regels.reduce((s, r) => s + r.bedrag_excl + r.btw_bedrag, 0), 6050);
  } finally {
    ctx.opruimen();
  }
});
