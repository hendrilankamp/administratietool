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
    assert.equal(per["Florano"].verkoopfacturen.length, 0);
    assert.equal(per["Akupaneldeal"].relatie_id, aku);
    assert.equal(rap.nietToegewezen.length, 0);
  } finally {
    ctx.opruimen();
  }
});
