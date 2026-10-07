import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { testCtx, categorieId } from "./helpers.ts";
import { aantalPaginas, aiKostenMaand, kostenMicroUsd, leesFactuurUit, type AiVoorstel } from "../src/integrations/ai/extract.ts";
import { isEigenLeverancier, isEigenOnderwerp, ruimEigenFacturenOp } from "../src/modules/facturen/eigen.ts";
import { bewaarBijlage } from "../src/lib/bijlagen.ts";
import { nieuweInkoopfactuur } from "../src/modules/facturen/service.ts";
import { slaInstellingenOp } from "../src/lib/instellingen.ts";

const pdf = (paginas: number) =>
  Buffer.from(`%PDF-1.4\n1 0 obj<</Type /Pages /Kids [] /Count ${paginas}>>endobj\n${"<</Type /Page>>\n".repeat(paginas)}%%EOF\n${Math.random()}`);

function voorstel(leverancier: string, btw: string | null = null): AiVoorstel {
  return {
    is_factuur: true,
    leverancier: { naam: leverancier, btw_nummer: btw, kvk: null, iban: null, email: null, adres: null, postcode: null, plaats: null, land: "NL" },
    ontvanger: null,
    factuurnummer: "F1",
    factuurdatum: "2026-10-01",
    vervaldatum: null,
    valuta: "EUR",
    is_creditnota: false,
    btw_verlegd: false,
    regels: [{ omschrijving: "Hosting", bedrag_excl: 10, btw_tarief: 21, btw_bedrag: 2.1 }],
    totaal_excl: 10,
    totaal_btw: 2.1,
    totaal_incl: 12.1,
    al_betaald: false,
    voorgestelde_categorie: "Software & abonnementen",
    opmerkingen: null,
  };
}

/** Nep-Claude: telt aanroepen, geeft een vast voorstel en tokenverbruik terug. */
function nepClient(v: AiVoorstel, teller: { n: number; laatste?: Record<string, unknown> }) {
  return {
    beta: {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          teller.n++;
          teller.laatste = params;
          return { stop_reason: "end_turn", parsed_output: v, usage: { input_tokens: 3000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
        },
      },
    },
  } as unknown as Anthropic;
}

test("kosten en paginatelling", () => {
  assert.equal(kostenMicroUsd("claude-sonnet-5-5", 3000, 500), 11_000); // $0,011
  assert.equal(kostenMicroUsd("claude-haiku-4-5", 3000, 500), 5_500);
  assert.equal(kostenMicroUsd("claude-opus-5-5", 3000, 500), 22_000);
  assert.equal(aantalPaginas(pdf(3)), 3);
  assert.equal(aantalPaginas(Buffer.from("%PDF-1.4\n<</Type /Page>>\n<</Type /Page>>\n%%EOF")), 2);
});

test("AI: Sonnet met effort low, verbruik vastgelegd, maandlimiet en paginalimiet", async () => {
  const ctx = await testCtx({ ANTHROPIC_API_KEY: "sk-ant-test-0123456789" });
  try {
    categorieId(ctx, "Software & abonnementen");
    const teller = { n: 0 } as { n: number; laatste?: Record<string, unknown> };
    const client = nepClient(voorstel("Hosting B.V."), teller);
    const maak = (p = 1) => nieuweInkoopfactuur(ctx, "upload", { bijlage: bewaarBijlage(ctx, pdf(p), "f.pdf").sha256, aiStatus: "wachtrij", gebruiker: "t" });

    const id1 = maak();
    await leesFactuurUit(ctx, id1, client);
    assert.equal(teller.n, 1);
    assert.equal(teller.laatste!.model, "claude-sonnet-5-5");
    assert.equal((teller.laatste!.output_config as { effort: string }).effort, "low");
    assert.equal(ctx.db.get<{ ai_status: string }>("SELECT ai_status FROM inkoopfacturen WHERE id = ?", [id1])!.ai_status, "klaar");
    const m = aiKostenMaand(ctx);
    assert.equal(m.facturen, 1);
    assert.ok(Math.abs(m.dollars - 0.011) < 1e-9);

    // Te veel pagina's: geen aanroep, status 'overgeslagen'
    const id2 = maak(25);
    await leesFactuurUit(ctx, id2, client);
    assert.equal(teller.n, 1);
    assert.equal(ctx.db.get<{ ai_status: string }>("SELECT ai_status FROM inkoopfacturen WHERE id = ?", [id2])!.ai_status, "overgeslagen");

    // Maandlimiet bereikt: geen aanroep meer
    slaInstellingenOp(ctx, [{ sleutel: "AI_LIMIET_MAAND", waarde: 0.01 }], "t");
    const id3 = maak();
    await leesFactuurUit(ctx, id3, client);
    assert.equal(teller.n, 1);
    const r = ctx.db.get<{ ai_status: string; ai_melding: string }>("SELECT ai_status, ai_melding FROM inkoopfacturen WHERE id = ?", [id3])!;
    assert.equal(r.ai_status, "overgeslagen");
    assert.match(r.ai_melding, /Maandlimiet/);

    // Haiku: zonder effort-parameter
    slaInstellingenOp(ctx, [{ sleutel: "AI_LIMIET_MAAND", waarde: 10 }, { sleutel: "AI_MODEL", waarde: "claude-haiku-4-5" }], "t");
    await leesFactuurUit(ctx, maak(), client);
    assert.equal(teller.laatste!.model, "claude-haiku-4-5");
    assert.equal((teller.laatste!.output_config as { effort?: string }).effort, undefined);
  } finally {
    ctx.opruimen();
  }
});

test("eigen facturen worden herkend en omgezet naar verkoop (of verwijderd als dubbel)", async () => {
  const ctx = await testCtx({ ANTHROPIC_API_KEY: "sk-ant-test-0123456789" });
  try {
    slaInstellingenOp(ctx, [{ sleutel: "EIGEN_NAAM", waarde: "Medialan" }, { sleutel: "EIGEN_BTW", waarde: "NL 0012.34567.B01" }], "t");
    assert.ok(isEigenOnderwerp(ctx, "Nieuwe factuur van Medialan"));
    assert.ok(isEigenOnderwerp(ctx, "Invoice from MEDIALAN"));
    assert.ok(!isEigenOnderwerp(ctx, "Factuur van KPN voor Medialan"));
    assert.ok(isEigenLeverancier(ctx, { naam: "Medialan B.V." }));
    assert.ok(isEigenLeverancier(ctx, { naam: "Iets anders", btw_nummer: "NL001234567B01" }));
    assert.ok(!isEigenLeverancier(ctx, { naam: "Mediamarkt" }));

    // AI herkent eigen bedrijf als afzender -> verkoopfactuur (concept) met klant uit de geadresseerde
    const teller = { n: 0 };
    const eigen = { ...voorstel("Medialan", "NL001234567B01"), factuurnummer: "2021-00131", ontvanger: { naam: "Nijkamp stoffering", btw_nummer: null, kvk: null, email: null, adres: null, postcode: null, plaats: "Rijssen", land: "NL" } };
    const id = nieuweInkoopfactuur(ctx, "email", { bijlage: bewaarBijlage(ctx, pdf(1), "f.pdf").sha256, aiStatus: "wachtrij", gebruiker: "t", omschrijving: "Re: Office licenties" });
    await leesFactuurUit(ctx, id, nepClient(eigen, teller));
    assert.equal(ctx.db.get("SELECT id FROM inkoopfacturen WHERE id = ?", [id]), undefined, "niet meer bij inkoop");
    const vk = ctx.db.get<{ id: number; status: string; factuurnummer: string; totaal_incl: number; relatie_id: number; bijlage_sha256: string }>("SELECT * FROM verkoopfacturen WHERE factuurnummer = '2021-00131'")!;
    assert.equal(vk.status, "concept");
    assert.equal(vk.totaal_incl, 1210);
    assert.ok(vk.bijlage_sha256);
    const klant = ctx.db.get<{ naam: string; type: string }>("SELECT naam, type FROM relaties WHERE id = ?", [vk.relatie_id])!;
    assert.deepEqual({ ...klant }, { naam: "Nijkamp stoffering", type: "klant" });
    const regel = ctx.db.get<{ btw_code: string; categorie_id: number }>("SELECT btw_code, categorie_id FROM verkoopfactuur_regels WHERE factuur_id = ?", [vk.id])!;
    assert.equal(regel.btw_code, "NL21");
    assert.equal(regel.categorie_id, categorieId(ctx, "Omzet"));

    // Zelfde factuur nog eens binnen (bv. nog een bcc) -> dubbele inkoop verwijderd, geen tweede verkoop
    const id2 = nieuweInkoopfactuur(ctx, "email", { bijlage: bewaarBijlage(ctx, pdf(1), "g.pdf").sha256, aiStatus: "wachtrij", gebruiker: "t" });
    await leesFactuurUit(ctx, id2, nepClient(eigen, teller));
    assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM verkoopfacturen WHERE factuurnummer = '2021-00131'")!.n, 1);
    assert.equal(ctx.db.get("SELECT id FROM inkoopfacturen WHERE id = ?", [id2]), undefined);

    // Zonder Mollie: onderwerp "factuur van Medialan" gaat gewoon naar de AI (kan niet weg, want niet via Mollie binnen)
    const n0 = teller.n;
    const id3 = nieuweInkoopfactuur(ctx, "email", { bijlage: bewaarBijlage(ctx, pdf(1), "h.pdf").sha256, aiStatus: "wachtrij", gebruiker: "t", omschrijving: "Nieuwe factuur van Medialan" });
    await leesFactuurUit(ctx, id3, nepClient({ ...eigen, factuurnummer: "I-2026-0042" }, teller));
    assert.equal(teller.n, n0 + 1);
    assert.ok(ctx.db.get("SELECT id FROM verkoopfacturen WHERE factuurnummer = 'I-2026-0042'"));
  } finally {
    ctx.opruimen();
  }
});

test("met Mollie: kopie op onderwerp wordt zonder AI verwijderd; opruimen zet bestaande om", async () => {
  const ctx = await testCtx({ ANTHROPIC_API_KEY: "sk-ant-test-0123456789", MOLLIE_TOKEN: "access_test1234567890" });
  try {
    slaInstellingenOp(ctx, [{ sleutel: "EIGEN_NAAM", waarde: "Medialan" }], "t");
    const teller = { n: 0 };
    const id = nieuweInkoopfactuur(ctx, "email", { bijlage: bewaarBijlage(ctx, pdf(1), "g.pdf").sha256, aiStatus: "wachtrij", gebruiker: "t", omschrijving: "Nieuwe factuur van Medialan" });
    await leesFactuurUit(ctx, id, nepClient(voorstel("x"), teller));
    assert.equal(teller.n, 0, "geen AI-aanroep");
    assert.equal(ctx.db.get("SELECT id FROM inkoopfacturen WHERE id = ?", [id]), undefined);

    const kopie = nieuweInkoopfactuur(ctx, "email", { gebruiker: "t", omschrijving: "Nieuwe factuur van Medialan" });
    const metVoorstel = nieuweInkoopfactuur(ctx, "email", { gebruiker: "t", omschrijving: "Re: licenties" });
    ctx.db.run("UPDATE inkoopfacturen SET ai_voorstel = ? WHERE id = ?", [JSON.stringify({ ...voorstel("Medialan"), factuurnummer: "2021-00099" }), metVoorstel]);
    const ander = nieuweInkoopfactuur(ctx, "email", { gebruiker: "t", omschrijving: "Factuur KPN" });
    assert.deepEqual(ruimEigenFacturenOp(ctx), { omgezet: 1, verwijderd: 1 });
    assert.equal(ctx.db.get("SELECT id FROM inkoopfacturen WHERE id = ?", [kopie]), undefined);
    assert.ok(ctx.db.get("SELECT id FROM verkoopfacturen WHERE factuurnummer = '2021-00099'"));
    assert.ok(ctx.db.get("SELECT id FROM inkoopfacturen WHERE id = ?", [ander]));
  } finally {
    ctx.opruimen();
  }
});
