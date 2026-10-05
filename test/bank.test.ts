import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testCtx, categorieId } from "./helpers.ts";
import { analyseer, draaiImportTerug, importeer, vindProfiel } from "../src/modules/csv-import/service.ts";
import { autoAfletteren, boekZonderFactuur, haalTransactie, koppel, ontbrekendeFacturen, openPosten, saldoOp, slaRekeningOp, transacties, voorstellen, voegSaldoControleToe } from "../src/modules/bank/service.ts";
import { haalFactuur, nieuweInkoopfactuur, nieuweVerkoopfactuur, werkFactuurBij } from "../src/modules/facturen/service.ts";
import { slaRelatieOp } from "../src/modules/relaties/service.ts";

const fixture = (f: string) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", f));

async function metRekening() {
  const ctx = await testCtx();
  const rek = slaRekeningOp(ctx, null, { naam: "N26 Zakelijk", iban: "DE89 3704 0044 0532 0130 00", bank: "N26", beginsaldo: 100000, begindatum: "2026-09-30" }, "test");
  return { ctx, rek };
}

test("N26 nieuw formaat wordt herkend en correct geparst", async () => {
  const { ctx, rek } = await metRekening();
  try {
    const a = analyseer(ctx, fixture("n26-nieuw.csv"), { doel: "banktransacties", rekeningId: rek });
    assert.equal(a.profiel?.naam, "N26");
    assert.equal(a.scheiding, ",");
    assert.equal(a.bank!.fouten.length, 0);
    const r = a.bank!.records;
    assert.equal(r.length, 5);
    assert.equal(r[0].bedrag, 95650);
    assert.equal(r[1].bedrag, -12100);
    assert.equal(r[1].tegenpartij_iban, "NL91ABNA0417164300");
    assert.equal(r[1].omschrijving, "Factuur HB-2026-118");
    // Twee identieke regels op één dag krijgen verschillende vingerafdrukken
    assert.notEqual(r[3].fingerprint, r[4].fingerprint);
  } finally {
    ctx.opruimen();
  }
});

test("N26 oud formaat, ING (Windows-1252, puntkomma, Af/Bij) en relaties", async () => {
  const { ctx, rek } = await metRekening();
  try {
    const oud = analyseer(ctx, fixture("n26-oud.csv"), { doel: "banktransacties", rekeningId: rek });
    assert.equal(oud.profiel?.naam, "N26 (oud formaat)");
    assert.equal(oud.bank!.records[0].bedrag, -12100);
    assert.equal(oud.bank!.records[1].bedrag, 25025);

    const ing = analyseer(ctx, fixture("ing-1252.csv"), { doel: "banktransacties", rekeningId: rek });
    assert.equal(ing.encoding, "windows-1252");
    assert.equal(ing.profiel?.naam, "ING (CSV, puntkomma)");
    assert.equal(ing.bank!.records[0].bedrag, -1250);
    assert.equal(ing.bank!.records[0].boekdatum, "2026-10-04");
    assert.equal(ing.bank!.records[0].tegenpartij_naam, "Café de Hoek");

    const rel = importeer(ctx, fixture("relaties.csv"), { doel: "relaties", profiel: vindProfiel(ctx, "Relaties (algemeen)")!, bestandsnaam: "relaties.csv", gebruiker: "test" });
    assert.equal(rel.nieuw, 2);
    const google = ctx.db.get<{ type: string; btw_nummer: string; land: string }>("SELECT type, btw_nummer, land FROM relaties WHERE naam LIKE 'Google%'");
    assert.deepEqual({ ...google }, { type: "leverancier", btw_nummer: "IE6388047V", land: "IE" });
    const opnieuw = importeer(ctx, fixture("relaties.csv"), { doel: "relaties", profiel: vindProfiel(ctx, "Relaties (algemeen)")!, bestandsnaam: "relaties.csv", gebruiker: "test" });
    assert.equal(opnieuw.nieuw, 0);
  } finally {
    ctx.opruimen();
  }
});

test("import is idempotent bij (overlappende) herhaalde exports en terug te draaien", async () => {
  const { ctx, rek } = await metRekening();
  try {
    const profiel = vindProfiel(ctx, "N26")!;
    const eerste = importeer(ctx, fixture("n26-nieuw.csv"), { doel: "banktransacties", profiel, rekeningId: rek, bestandsnaam: "a.csv", gebruiker: "test" });
    assert.deepEqual([eerste.nieuw, eerste.dubbel], [5, 0]);
    const tweede = importeer(ctx, fixture("n26-nieuw.csv"), { doel: "banktransacties", profiel, rekeningId: rek, bestandsnaam: "a.csv", gebruiker: "test" });
    assert.deepEqual([tweede.nieuw, tweede.dubbel], [0, 5]);
    // Saldo: 1000 + 956,50 - 121 - 9,90 - 4,50 - 4,50
    assert.equal(saldoOp(ctx, rek, "2026-10-31"), 100000 + 95650 - 12100 - 990 - 450 - 450);
    const c = voegSaldoControleToe(ctx, rek, "2026-10-31", 181660, "test");
    assert.equal(c.verschil, 0);

    assert.equal(draaiImportTerug(ctx, tweede.batchId, "test"), 0);
    const tx = transacties(ctx)[0];
    boekZonderFactuur(ctx, tx.id, categorieId(ctx, "Bankkosten"), null, "test");
    assert.throws(() => draaiImportTerug(ctx, eerste.batchId, "test"), /afgeletterd/);
  } finally {
    ctx.opruimen();
  }
});

test("afletteren: voorstel op factuurnummer + bedrag, automatisch koppelen en betaalstatus", async () => {
  const { ctx, rek } = await metRekening();
  try {
    const lev = slaRelatieOp(ctx, null, { naam: "Hosting Bedrijf B.V.", type: "leverancier", iban: "NL91ABNA0417164300" }, "test");
    const inkoop = nieuweInkoopfactuur(ctx, "handmatig", { gebruiker: "test" });
    werkFactuurBij(ctx, "inkoop", inkoop, { relatie_id: lev, factuurnummer: "HB-2026-118", factuurdatum: "2026-09-20", regels: [{ categorie_id: categorieId(ctx, "Software & abonnementen"), bedrag_excl: 10000, btw_code: "NL21" }] }, { gebruiker: "test", boeken: true });

    importeer(ctx, fixture("n26-nieuw.csv"), { doel: "banktransacties", profiel: vindProfiel(ctx, "N26")!, rekeningId: rek, bestandsnaam: "a.csv", gebruiker: "test" });
    const hostingTx = transacties(ctx).find((t) => t.omschrijving === "Factuur HB-2026-118")!;
    const vs = voorstellen(ctx, hostingTx);
    assert.equal(vs[0].soort, "factuur");
    assert.ok(vs[0].score >= 100, `score ${vs[0].score}`);
    assert.deepEqual(vs[0].koppelingen[0], { soort: "inkoop", factuurId: inkoop, bedrag: -12100, label: "HB-2026-118" });

    assert.equal(autoAfletteren(ctx), 1);
    assert.equal(haalTransactie(ctx, hostingTx.id)!.status, "gekoppeld");
    assert.equal(haalFactuur(ctx, "inkoop", inkoop)!.betaalstatus, "betaald");
    assert.ok(!openPosten(ctx).some((p) => p.id === inkoop && p.soort === "inkoop"));
    // Albert Heijn-afschrijvingen hebben geen factuur
    assert.ok(ontbrekendeFacturen(ctx, 0, 0).some((t) => t.tegenpartij_naam === "Albert Heijn"));
  } finally {
    ctx.opruimen();
  }
});

test("Mollie-uitbetaling: meerdere verkoopfacturen + ingehouden kosten in één bijschrijving", async () => {
  const { ctx, rek } = await metRekening();
  try {
    const klant = slaRelatieOp(ctx, null, { naam: "Klant", type: "klant" }, "test");
    const omzet = categorieId(ctx, "Omzet");
    const ids: number[] = [];
    for (const [nr, excl] of [["INV-1", 50000], ["INV-2", 30000]] as const) {
      const id = nieuweVerkoopfactuur(ctx, "test");
      werkFactuurBij(ctx, "verkoop", id, { relatie_id: klant, factuurnummer: nr, factuurdatum: "2026-09-25", regels: [{ categorie_id: omzet, bedrag_excl: excl, btw_code: "NL21" }] }, { gebruiker: "test", boeken: true });
      ids.push(id);
    }
    // 605 + 363 = 968; Mollie houdt 11,50 kosten in -> 956,50
    const u = ctx.db.run("INSERT INTO mollie_uitbetalingen (mollie_id, referentie, status, bedrag, kosten, uitbetaald_op) VALUES ('stl_1', '07049691.2610.01', 'paidout', 95650, 1150, '2026-10-01')").id;
    ctx.db.run("INSERT INTO mollie_uitbetaling_facturen (uitbetaling_id, verkoopfactuur_id, bedrag) VALUES (?, ?, 60500), (?, ?, 36300)", [u, ids[0], u, ids[1]]);

    importeer(ctx, fixture("n26-nieuw.csv"), { doel: "banktransacties", profiel: vindProfiel(ctx, "N26")!, rekeningId: rek, bestandsnaam: "a.csv", gebruiker: "test" });
    const tx = transacties(ctx).find((t) => t.tegenpartij_naam === "Stichting Mollie Payments")!;
    const [v] = voorstellen(ctx, tx);
    assert.equal(v.soort, "mollie");
    assert.equal(v.koppelingen.length, 2);
    assert.equal(v.rest?.bedrag, -1150);
    koppel(ctx, tx.id, v.koppelingen, { restCategorieId: v.rest!.categorieId, gebruiker: "test" });
    assert.equal(haalTransactie(ctx, tx.id)!.status, "gekoppeld");
    for (const id of ids) assert.equal(haalFactuur(ctx, "verkoop", id)!.betaalstatus, "betaald");
    assert.throws(() => koppel(ctx, tx.id, [{ soort: "verkoop", factuurId: ids[0], bedrag: 100 }], { gebruiker: "test" }), /hoger dan/);
  } finally {
    ctx.opruimen();
  }
});
