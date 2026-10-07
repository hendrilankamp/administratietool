import { test } from "node:test";
import assert from "node:assert/strict";
import { testCtx, categorieId } from "./helpers.ts";
import type { AiVoorstel } from "../src/integrations/ai/extract.ts";
import { aanvullingen, koppelLeverancierAanFactuur, koppelOnbekendeLeveranciers, leverancierVelden, vulLeverancierAan } from "../src/modules/facturen/leverancier-uit-factuur.ts";
import { haalRelatie, slaRelatieOp } from "../src/modules/relaties/service.ts";
import { nieuweInkoopfactuur } from "../src/modules/facturen/service.ts";

const voorstel = (naam = "Google Ireland Limited"): AiVoorstel => ({
  is_factuur: true,
  leverancier: { naam, btw_nummer: "IE 6388047V", kvk: "KvK: 1234-5678", iban: "ie29 aibk 9311 5212 3456 78", email: "geen e-mail", adres: "Gordon House, Barrow Street", postcode: "D04 E5W5", plaats: "Dublin", land: "ie" },
  ontvanger: null,
  factuurnummer: "5123", factuurdatum: "2026-09-30", vervaldatum: null, valuta: "EUR", is_creditnota: false, btw_verlegd: true,
  regels: [{ omschrijving: "Ads", klant: null, periode: null, bedrag_excl: 250, btw_tarief: 0, btw_bedrag: 0 }], totaal_excl: 250, totaal_btw: 0, totaal_incl: 250,
  al_betaald: true, voorgestelde_categorie: "Advertentiekosten", opmerkingen: null,
});

test("leveranciersgegevens uit factuur worden opgeschoond en zijn geldig als relatie", async () => {
  const ctx = await testCtx();
  try {
    const v = leverancierVelden(ctx, voorstel(), [{ categorie_id: null, btw_code: "EU_DIENST" }]);
    assert.equal(v.btw_nummer, "IE6388047V");
    assert.equal(v.kvk, "12345678");
    assert.equal(v.iban, "IE29AIBK93115212345678");
    assert.equal(v.email, null, "ongeldig e-mailadres wordt weggelaten");
    assert.equal(v.land, "IE");
    assert.equal(v.standaard_categorie_id, categorieId(ctx, "Advertentiekosten"));
    assert.equal(v.standaard_btw_code, "EU_DIENST");
    const id = slaRelatieOp(ctx, null, v, "t");
    assert.equal(haalRelatie(ctx, id)!.naam, "Google Ireland Limited");
  } finally {
    ctx.opruimen();
  }
});

test("aanvullen overschrijft niets; andere facturen van dezelfde leverancier worden gekoppeld", async () => {
  const ctx = await testCtx();
  try {
    const rel = slaRelatieOp(ctx, null, { naam: "Google Ireland", type: "leverancier", btw_nummer: "IE6388047V", plaats: "Cork" }, "t");
    const a = aanvullingen(ctx, haalRelatie(ctx, rel)!, voorstel());
    assert.ok(a.iban && a.adres && !("plaats" in a) && !("btw_nummer" in a));
    assert.deepEqual(vulLeverancierAan(ctx, rel, voorstel(), "t").sort(), ["IBAN", "KvK-nummer", "adres", "postcode"].sort());
    assert.equal(haalRelatie(ctx, rel)!.plaats, "Cork", "bestaande waarde blijft staan");

    // Twee te beoordelen facturen zonder leverancier, met voorstel van dezelfde leverancier
    const f1 = nieuweInkoopfactuur(ctx, "upload", { gebruiker: "t" });
    const f2 = nieuweInkoopfactuur(ctx, "upload", { gebruiker: "t" });
    for (const f of [f1, f2]) ctx.db.run("UPDATE inkoopfacturen SET ai_voorstel = ? WHERE id = ?", [JSON.stringify(voorstel()), f]);
    ctx.db.run("INSERT INTO inkoopfactuur_regels (factuur_id, bedrag_excl, btw_code, btw_bedrag) VALUES (?, 25000, 'EU_DIENST', 0)", [f1]);
    ctx.db.run("UPDATE relaties SET standaard_categorie_id = ? WHERE id = ?", [categorieId(ctx, "Advertentiekosten"), rel]);
    koppelLeverancierAanFactuur(ctx, f1, rel);
    assert.equal(ctx.db.get<{ categorie_id: number }>("SELECT categorie_id FROM inkoopfactuur_regels WHERE factuur_id = ?", [f1])!.categorie_id, categorieId(ctx, "Advertentiekosten"));
    assert.equal(koppelOnbekendeLeveranciers(ctx), 1);
    assert.equal(ctx.db.get<{ relatie_id: number }>("SELECT relatie_id FROM inkoopfacturen WHERE id = ?", [f2])!.relatie_id, rel);
  } finally {
    ctx.opruimen();
  }
});

test("melding 'leverancier nog niet bekend' verdwijnt na koppelen", async () => {
  const { actueleMeldingen } = await import("../src/modules/facturen/leverancier-uit-factuur.ts");
  const m = 'Leverancier "MCXess B.V." is nog niet bekend; maak hem aan vanuit het voorstel.\nAI: controleer de vervaldatum';
  assert.deepEqual(actueleMeldingen(m, false).length, 2);
  assert.deepEqual(actueleMeldingen(m, true), ["AI: controleer de vervaldatum"]);
  const ctx = await testCtx();
  try {
    const rel = slaRelatieOp(ctx, null, { naam: "MCXess B.V.", type: "leverancier" }, "t");
    const f = nieuweInkoopfactuur(ctx, "upload", { gebruiker: "t" });
    ctx.db.run("UPDATE inkoopfacturen SET ai_melding = ? WHERE id = ?", ['Leverancier "MCXess B.V." is nog niet bekend; maak hem aan vanuit het voorstel.', f]);
    koppelLeverancierAanFactuur(ctx, f, rel);
    assert.equal(ctx.db.get<{ ai_melding: string | null }>("SELECT ai_melding FROM inkoopfacturen WHERE id = ?", [f])!.ai_melding, null);
  } finally {
    ctx.opruimen();
  }
});
