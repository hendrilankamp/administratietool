import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { testCtx, categorieId } from "./helpers.ts";
import { leesFactuurUit, type AiVoorstel } from "../src/integrations/ai/extract.ts";
import { bewaarBijlage } from "../src/lib/bijlagen.ts";
import { haalFactuur, nieuweInkoopfactuur, nieuweVerkoopfactuur, werkFactuurBij } from "../src/modules/facturen/service.ts";
import { slaRelatieOp } from "../src/modules/relaties/service.ts";
import { koppelDoorbelastingen } from "../src/modules/facturen/leverancier-uit-factuur.ts";
import { doorbelastingPerKlant } from "../src/modules/rapportages/service.ts";

// De DSA-factuur F20268778: regels gegroepeerd per klant, BTW alleen als totaal (4,80)
const dsa: AiVoorstel = {
  is_factuur: true,
  leverancier: { naam: "DSA ICT Services & Software B.V.", btw_nummer: "NL009624892B01", kvk: "24171009", iban: "NL06ABNA0504587080", email: "sales@dsaict.com", adres: "Oslo 12", postcode: "2993 LD", plaats: "Barendrecht", land: "NL" },
  ontvanger: { naam: "MediaLan", btw_nummer: "NL215839572B01", kvk: null, email: null, adres: "Kievit 40", postcode: "7462 ZJ", plaats: "Rijssen", land: "NL" },
  factuurnummer: "F20268778", factuurdatum: "2026-10-02", vervaldatum: "2026-10-16", valuta: "EUR", is_creditnota: false, btw_verlegd: false,
  regels: [
    { omschrijving: "Microsoft Exchange Online Plan 1", klant: "Akupaneldeal.nl", periode: "01.09.2026 tot 01.10.2026", bedrag_excl: 3.2, btw_tarief: 21, btw_bedrag: 0.67 },
    { omschrijving: "Microsoft 365 Business Basic", klant: "Florano", periode: "14.09.2026 tot 01.10.2026", bedrag_excl: 2.56, btw_tarief: 21, btw_bedrag: 0.54 },
    { omschrijving: "Microsoft 365 Business Standard", klant: "lunieq.nl", periode: "01.09.2026 tot 01.10.2026", bedrag_excl: 10.69, btw_tarief: 21, btw_bedrag: 2.24 },
    { omschrijving: "Microsoft Exchange Online Plan 1 (2x)", klant: "Nijkamp Vloeren", periode: "01.09.2026 tot 01.10.2026", bedrag_excl: 6.4, btw_tarief: 21, btw_bedrag: 1.34 },
  ],
  totaal_excl: 22.85, totaal_btw: 4.8, totaal_incl: 27.65, al_betaald: false, voorgestelde_categorie: "Software & abonnementen", opmerkingen: null,
};

const nepClient = (v: AiVoorstel) =>
  ({ beta: { messages: { parse: async () => ({ stop_reason: "end_turn", parsed_output: v, usage: { input_tokens: 3000, output_tokens: 600 } }) } } }) as unknown as Anthropic;

test("DSA-factuur: regels per klant, BTW sluit aan op 4,80, doorbelasting-rapport", async () => {
  const ctx = await testCtx({ ANTHROPIC_API_KEY: "sk-ant-test-0123456789" });
  try {
    const florano = slaRelatieOp(ctx, null, { naam: "Florano", type: "klant" }, "t");
    const lunieq = slaRelatieOp(ctx, null, { naam: "Lunieq", type: "klant" }, "t");
    const nijkamp = slaRelatieOp(ctx, null, { naam: "Nijkamp Vloeren", type: "klant" }, "t");
    slaRelatieOp(ctx, null, { naam: "DSA ICT Services & Software B.V.", type: "leverancier", btw_nummer: "NL009624892B01" }, "t");

    const id = nieuweInkoopfactuur(ctx, "email", { bijlage: bewaarBijlage(ctx, Buffer.from("%PDF-1.4\n%%EOF\ndsa"), "F20268778.pdf").sha256, aiStatus: "wachtrij", gebruiker: "t" });
    await leesFactuurUit(ctx, id, nepClient(dsa));
    const f = haalFactuur(ctx, "inkoop", id)!;
    assert.equal(f.regels.length, 4, "regels niet samengevoegd");
    assert.equal(f.totaal_btw, 480, "BTW sluit aan op de factuur");
    assert.equal(f.totaal_incl, 2765);
    assert.deepEqual(f.regels.map((r) => r.doorbelast_relatie_id), [null, florano, lunieq, nijkamp]);
    assert.equal(f.regels[0].doorbelast_naam, "Akupaneldeal.nl");
    assert.equal(f.regels[2].periode, "01.09.2026 tot 01.10.2026");
    assert.match(f.ai_melding ?? "", /Akupaneldeal\.nl/);

    // Klant later aanmaken -> regel wordt automatisch gekoppeld
    const aku = slaRelatieOp(ctx, null, { naam: "Akupaneldeal", type: "klant", email: "info@akupaneldeal.nl" }, "t");
    assert.equal(koppelDoorbelastingen(ctx), 1);

    // Boeken (via het formulier: velden blijven behouden) en een verkoopfactuur aan Lunieq
    const herladen = haalFactuur(ctx, "inkoop", id)!;
    werkFactuurBij(ctx, "inkoop", id, { ...herladen, regels: herladen.regels.map((r) => ({ ...r, categorie_id: categorieId(ctx, "Software & abonnementen") })) }, { gebruiker: "t", boeken: true });
    const v = nieuweVerkoopfactuur(ctx, "t");
    werkFactuurBij(ctx, "verkoop", v, { relatie_id: lunieq, factuurnummer: "V1", factuurdatum: "2026-10-05", regels: [{ categorie_id: categorieId(ctx, "Omzet"), bedrag_excl: 1500, btw_code: "NL21" }] }, { gebruiker: "t", boeken: true });

    const rap = doorbelastingPerKlant(ctx, "2026-01-01", "2026-12-31");
    const per = Object.fromEntries(rap.klanten.map((k) => [k.naam, k]));
    assert.equal(per["Lunieq"].ingekocht, 1069);
    assert.equal(per["Lunieq"].verkocht, 1500);
    assert.equal(per["Lunieq"].verschil, 431);
    assert.equal(per["Florano"].verkoop.length, 0);
    assert.equal(per["Akupaneldeal"].relatie_id, aku);
    assert.equal(rap.nietToegewezen.length, 0);
  } finally {
    ctx.opruimen();
  }
});

test("jaarlijkse verkoopfactuur tegenover maandelijkse inkoop wordt naar rato verdeeld", async () => {
  const ctx = await testCtx();
  try {
    const klant = slaRelatieOp(ctx, null, { naam: "Florano", type: "klant" }, "t");
    const lev = slaRelatieOp(ctx, null, { naam: "DSA", type: "leverancier" }, "t");
    const sw = categorieId(ctx, "Software & abonnementen");
    // 12 maanden inkoop van € 10 (factuur begin volgende maand, periode = vorige maand)
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, "0");
      const laatste = new Date(Date.UTC(2026, m, 0)).getUTCDate();
      const id = nieuweInkoopfactuur(ctx, "handmatig", { gebruiker: "t" });
      const fd = m === 12 ? "2026-12-31" : `2026-${String(m + 1).padStart(2, "0")}-02`;
      werkFactuurBij(ctx, "inkoop", id, { relatie_id: lev, factuurnummer: `I${m}`, factuurdatum: fd, regels: [{ categorie_id: sw, bedrag_excl: 1000, btw_code: "NL21", doorbelast_relatie_id: klant, periode_van: `2026-${mm}-01`, periode_tot: `2026-${mm}-${laatste}` }] }, { gebruiker: "t", boeken: true });
    }
    // Eén jaarfactuur in januari van € 180 voor heel 2026
    const v = nieuweVerkoopfactuur(ctx, "t");
    werkFactuurBij(ctx, "verkoop", v, { relatie_id: klant, factuurnummer: "JAAR-2026", factuurdatum: "2026-01-10", regels: [{ categorie_id: categorieId(ctx, "Omzet"), bedrag_excl: 18000, btw_code: "NL21", periode_van: "2026-01-01", periode_tot: "2026-12-31" }] }, { gebruiker: "t", boeken: true });

    const q3 = doorbelastingPerKlant(ctx, "2026-07-01", "2026-09-30").klanten[0];
    assert.equal(q3.ingekocht, 3000, "juli t/m september inkoop (de september-inkoop is gefactureerd in oktober)");
    assert.equal(q3.verkocht, Math.round(18000 * 92 / 365), "kwart van de jaarfactuur (92 dagen)");
    const jaar = doorbelastingPerKlant(ctx, "2026-01-01", "2026-12-31").klanten[0];
    assert.equal(jaar.ingekocht, 12000);
    assert.equal(jaar.verkocht, 18000);
    assert.equal(jaar.verschil, 6000);
  } finally {
    ctx.opruimen();
  }
});

test("klant met meerdere handelsnamen: oude naam op inkoop wordt herkend", async () => {
  const { zoekKlant, zoekRelatieMatch } = await import("../src/modules/relaties/service.ts");
  const ctx = await testCtx();
  try {
    const id = slaRelatieOp(ctx, null, { naam: "Paneldeal", type: "klant", aliassen: "Akupaneldeal\n akupaneldeal.nl \n" }, "t");
    assert.equal(zoekKlant(ctx, "Akupaneldeal.nl")?.id, id);
    assert.equal(zoekKlant(ctx, "Paneldeal")?.id, id);
    assert.equal(zoekRelatieMatch(ctx, { naam: "Akupaneldeal" })?.id, id);
    const f = nieuweInkoopfactuur(ctx, "handmatig", { gebruiker: "t" });
    ctx.db.run("INSERT INTO inkoopfactuur_regels (factuur_id, bedrag_excl, btw_code, btw_bedrag, doorbelast_naam) VALUES (?, 320, 'NL21', 67, 'Akupaneldeal.nl')", [f]);
    assert.equal(koppelDoorbelastingen(ctx), 1);
    assert.equal(ctx.db.get<{ doorbelast_relatie_id: number }>("SELECT doorbelast_relatie_id FROM inkoopfactuur_regels WHERE factuur_id = ?", [f])!.doorbelast_relatie_id, id);
    assert.equal(ctx.db.get<{ aliassen: string }>("SELECT aliassen FROM relaties WHERE id = ?", [id])!.aliassen, "Akupaneldeal\nakupaneldeal.nl");
  } finally {
    ctx.opruimen();
  }
});

test("marge-alarm: onder 20% (ook met jaarfactuur naar rato) en zonder verkoop", async () => {
  const { margeAlarmen } = await import("../src/modules/rapportages/service.ts");
  const ctx = await testCtx();
  try {
    const sw = categorieId(ctx, "Software & abonnementen");
    const omzet = categorieId(ctx, "Omzet");
    const lev = slaRelatieOp(ctx, null, { naam: "DSA", type: "leverancier" }, "t");
    const goed = slaRelatieOp(ctx, null, { naam: "Goed BV", type: "klant" }, "t");
    const krap = slaRelatieOp(ctx, null, { naam: "Krap BV", type: "klant" }, "t");
    const niets = slaRelatieOp(ctx, null, { naam: "Vergeten BV", type: "klant" }, "t");
    let nr = 0;
    // Okt 2025 t/m sep 2026: per klant € 10 inkoop per maand
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(2025, 9 + i, 1));
      const ym = d.toISOString().slice(0, 7);
      const laatste = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      for (const k of [goed, krap, niets]) {
        const id = nieuweInkoopfactuur(ctx, "handmatig", { gebruiker: "t" });
        werkFactuurBij(ctx, "inkoop", id, { relatie_id: lev, factuurnummer: `I${nr++}`, factuurdatum: laatste, regels: [{ categorie_id: sw, bedrag_excl: 1000, btw_code: "NL21", doorbelast_relatie_id: k, periode_van: `${ym}-01`, periode_tot: laatste }] }, { gebruiker: "t", boeken: true });
      }
    }
    // Goed: jaarfactuur € 180 voor okt 2025 – sep 2026 (33% marge); Krap: € 130 (7,7% marge)
    for (const [k, b] of [[goed, 18000], [krap, 13000]] as const) {
      const v = nieuweVerkoopfactuur(ctx, "t");
      werkFactuurBij(ctx, "verkoop", v, { relatie_id: k, factuurnummer: `V${k}`, factuurdatum: "2025-10-05", regels: [{ categorie_id: omzet, bedrag_excl: b, btw_code: "NL21", periode_van: "2025-10-01", periode_tot: "2026-09-30" }] }, { gebruiker: "t", boeken: true });
    }
    const r = margeAlarmen(ctx, new Date(2026, 9, 8)); // 8 okt 2026 → venster okt 2025 t/m sep 2026
    assert.equal(r.van, "2025-10-01");
    assert.equal(r.tot, "2026-09-30");
    assert.deepEqual(r.alarmen.map((a) => a.naam), ["Vergeten BV", "Krap BV"]);
    assert.equal(r.alarmen[0].marge, null);
    assert.ok(Math.abs(r.alarmen[1].marge! - (1000 / 13000) * 100) < 0.01);
  } finally {
    ctx.opruimen();
  }
});

test("verkoop aan klant tegenover inkoop van meerdere leveranciers", async () => {
  const ctx = await testCtx();
  try {
    const klant = slaRelatieOp(ctx, null, { naam: "Florano", type: "klant" }, "t");
    const sw = categorieId(ctx, "Software & abonnementen");
    let n = 0;
    for (const [lev, bedrag] of [["DSA", 1000], ["Vimexx", 500], ["Domeinen BV", 250]] as const) {
      const l = slaRelatieOp(ctx, null, { naam: lev, type: "leverancier" }, "t");
      const id = nieuweInkoopfactuur(ctx, "handmatig", { gebruiker: "t" });
      werkFactuurBij(ctx, "inkoop", id, { relatie_id: l, factuurnummer: `I${n++}`, factuurdatum: "2026-05-01", regels: [{ categorie_id: sw, bedrag_excl: bedrag, btw_code: "NL21", doorbelast_relatie_id: klant }] }, { gebruiker: "t", boeken: true });
    }
    const v = nieuweVerkoopfactuur(ctx, "t");
    werkFactuurBij(ctx, "verkoop", v, { relatie_id: klant, factuurnummer: "V1", factuurdatum: "2026-05-10", regels: [{ categorie_id: categorieId(ctx, "Omzet"), bedrag_excl: 2500, btw_code: "NL21" }] }, { gebruiker: "t", boeken: true });
    const k = doorbelastingPerKlant(ctx, "2026-04-01", "2026-06-30").klanten[0];
    assert.equal(k.ingekocht, 1750);
    assert.equal(new Set(k.regels.map((r) => r.leverancier)).size, 3);
    assert.equal(k.verkocht, 2500);
    assert.equal(k.verschil, 750); // 30% marge
  } finally {
    ctx.opruimen();
  }
});
