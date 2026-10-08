import { test } from "node:test";
import assert from "node:assert/strict";
import { testCtx, categorieId } from "./helpers.ts";
import { berekenAangifte, sluitPeriode } from "../src/modules/btw/service.ts";
import { haalFactuur, nieuweInkoopfactuur, nieuweVerkoopfactuur, verwijderFactuur, werkFactuurBij } from "../src/modules/facturen/service.ts";
import { slaRelatieOp } from "../src/modules/relaties/service.ts";
import { kiesBtwCode, vertaalVoorstel, type AiVoorstel } from "../src/integrations/ai/extract.ts";
import { mollieBtwCode, syncVerkoopfacturen, vertaalMollieFactuur, type MollieSalesInvoice } from "../src/integrations/mollie/index.ts";

test("BTW-aangifte: rubrieken 1a, 1b, 3b, 4a, 4b, 2a en voorbelasting", async () => {
  const ctx = await testCtx();
  try {
    const klant = slaRelatieOp(ctx, null, { naam: "Klant NL", type: "klant" }, "t");
    const eu = slaRelatieOp(ctx, null, { naam: "Klant DE", type: "klant", land: "DE" }, "t");
    const google = slaRelatieOp(ctx, null, { naam: "Google Ireland", type: "leverancier", land: "IE" }, "t");
    const kpn = slaRelatieOp(ctx, null, { naam: "KPN", type: "leverancier" }, "t");
    const omzet = categorieId(ctx, "Omzet");
    const adv = categorieId(ctx, "Advertentiekosten");
    const tel = categorieId(ctx, "Telefoon & internet");

    const v = nieuweVerkoopfactuur(ctx, "t");
    werkFactuurBij(ctx, "verkoop", v, { relatie_id: klant, factuurnummer: "1", factuurdatum: "2026-10-10", regels: [
      { categorie_id: omzet, bedrag_excl: 100000, btw_code: "NL21" },
      { categorie_id: omzet, bedrag_excl: 10000, btw_code: "NL9" },
    ] }, { gebruiker: "t", boeken: true });
    const v2 = nieuweVerkoopfactuur(ctx, "t");
    werkFactuurBij(ctx, "verkoop", v2, { relatie_id: eu, factuurnummer: "2", factuurdatum: "2026-11-01", regels: [{ categorie_id: omzet, bedrag_excl: 50000, btw_code: "EU_DIENST" }] }, { gebruiker: "t", boeken: true });
    const i1 = nieuweInkoopfactuur(ctx, "handmatig", { gebruiker: "t" });
    werkFactuurBij(ctx, "inkoop", i1, { relatie_id: google, factuurnummer: "G1", factuurdatum: "2026-10-31", regels: [{ categorie_id: adv, bedrag_excl: 20000, btw_code: "EU_DIENST" }] }, { gebruiker: "t", boeken: true });
    const i2 = nieuweInkoopfactuur(ctx, "handmatig", { gebruiker: "t" });
    werkFactuurBij(ctx, "inkoop", i2, { relatie_id: kpn, factuurnummer: "K1", factuurdatum: "2026-12-31", regels: [{ categorie_id: tel, bedrag_excl: 5000, btw_code: "NL21", btw_bedrag: 1050 }] }, { gebruiker: "t", boeken: true });
    // Buiten het kwartaal: telt niet mee
    const i3 = nieuweInkoopfactuur(ctx, "handmatig", { gebruiker: "t" });
    werkFactuurBij(ctx, "inkoop", i3, { relatie_id: kpn, factuurnummer: "K0", factuurdatum: "2026-09-30", regels: [{ categorie_id: tel, bedrag_excl: 5000, btw_code: "NL21" }] }, { gebruiker: "t", boeken: true });

    const a = berekenAangifte(ctx.db, 2026, 4);
    const r = Object.fromEntries(a.regels.map((x) => [x.rubriek, x]));
    assert.deepEqual([r["1a"].grondslag, r["1a"].btw], [100000, 21000]);
    assert.deepEqual([r["1b"].grondslag, r["1b"].btw], [10000, 900]);
    assert.deepEqual([r["3b"].grondslag, r["3b"].btw], [50000, 0]);
    assert.deepEqual([r["4b"].grondslag, r["4b"].btw], [20000, 4200]);
    assert.equal(a.verschuldigd, 21000 + 900 + 4200);
    assert.equal(a.voorbelasting, 4200 + 1050);
    assert.equal(a.saldo, 21000 + 900 + 4200 - 5250);
    const euros = Object.fromEntries(a.aangifteEuros.map((x) => [x.rubriek, x]));
    assert.equal(euros["5c"].btw, 261 - 53); // 210+9+42 = 261 omlaag; 52,50 voorbelasting omhoog = 53
    assert.equal(a.aantalFacturen.inkoop, 2);
  } finally {
    ctx.opruimen();
  }
});

test("afgesloten periode blokkeert wijzigen en boeken; geboekte factuur niet te verwijderen", async () => {
  const ctx = await testCtx();
  try {
    const kpn = slaRelatieOp(ctx, null, { naam: "KPN", type: "leverancier" }, "t");
    const tel = categorieId(ctx, "Telefoon & internet");
    const id = nieuweInkoopfactuur(ctx, "handmatig", { gebruiker: "t" });
    const inv = { relatie_id: kpn, factuurnummer: "K1", factuurdatum: "2026-07-15", regels: [{ categorie_id: tel, bedrag_excl: 5000, btw_code: "NL21" }] };
    werkFactuurBij(ctx, "inkoop", id, inv, { gebruiker: "t", boeken: true });
    berekenAangifte(ctx.db, 2026, 3);
    sluitPeriode(ctx.db, "2026-Q3");
    assert.throws(() => werkFactuurBij(ctx, "inkoop", id, { ...inv, factuurnummer: "K1b" }, { gebruiker: "t" }), /afgesloten/);
    const nieuw = nieuweInkoopfactuur(ctx, "handmatig", { gebruiker: "t" });
    assert.throws(() => werkFactuurBij(ctx, "inkoop", nieuw, { ...inv, factuurnummer: "K2" }, { gebruiker: "t", boeken: true }), /afgesloten/);
    assert.throws(() => verwijderFactuur(ctx, "inkoop", id, "t"), /creditfactuur/);
    // Dubbel factuurnummer per leverancier wordt geweigerd
    assert.throws(() => werkFactuurBij(ctx, "inkoop", nieuw, { ...inv, factuurdatum: "2026-10-01" }, { gebruiker: "t", boeken: true }), /bestaat al/);
    assert.equal(haalFactuur(ctx, "inkoop", id)!.totaal_incl, 6050);
  } finally {
    ctx.opruimen();
  }
});

test("AI-voorstel: BTW-code keuze, controles en leveranciermatch", async () => {
  const ctx = await testCtx();
  try {
    assert.equal(kiesBtwCode(21, false, "NL", null), "NL21");
    assert.equal(kiesBtwCode(0, true, "IE", null), "EU_DIENST");
    assert.equal(kiesBtwCode(0, false, null, "IE6388047V"), "EU_DIENST");
    assert.equal(kiesBtwCode(0, true, "US", null), "BUITEN_EU");
    assert.equal(kiesBtwCode(0, true, "NL", null), "VERLEGD_NL");

    const google = slaRelatieOp(ctx, null, { naam: "Google Ireland Ltd", type: "leverancier", btw_nummer: "IE 6388047V", standaard_categorie_id: categorieId(ctx, "Advertentiekosten") }, "t");
    const voorstel: AiVoorstel = {
      is_factuur: true,
      leverancier: { naam: "Google Ireland Limited", btw_nummer: "IE6388047V", kvk: null, iban: null, email: null, adres: null, postcode: null, plaats: "Dublin", land: "IE" },
      ontvanger: null,
      factuurnummer: "5123456789",
      factuurdatum: "2026-09-30",
      vervaldatum: null,
      valuta: "EUR",
      is_creditnota: false,
      btw_verlegd: true,
      regels: [{ omschrijving: "Google Ads", klant: null, periode: null, bedrag_excl: 250.0, btw_tarief: 0, btw_bedrag: 0 }],
      totaal_excl: 250,
      totaal_btw: 0,
      totaal_incl: 250,
      al_betaald: true,
      voorgestelde_categorie: "Advertentiekosten",
      opmerkingen: null,
    };
    const v = vertaalVoorstel(ctx, voorstel);
    assert.equal(v.relatie_id, google);
    assert.equal(v.regels[0].btw_code, "EU_DIENST");
    assert.equal(v.regels[0].bedrag_excl, 25000);
    assert.ok(v.meldingen.some((m) => m.includes("al betaald")));
    assert.ok(!v.meldingen.some((m) => m.includes("wijkt af")));

    const fout = vertaalVoorstel(ctx, { ...voorstel, btw_verlegd: false, leverancier: { ...voorstel.leverancier, land: "NL", btw_nummer: null, naam: "Onbekend BV" }, regels: [{ omschrijving: "x", klant: null, periode: null, bedrag_excl: 100, btw_tarief: 21, btw_bedrag: 30 }], totaal_incl: 130, totaal_excl: 100 });
    assert.equal(fout.relatie_id, null);
    assert.ok(fout.meldingen.some((m) => m.includes("past niet")));
    assert.ok(fout.meldingen.some((m) => m.includes("nog niet bekend")));
  } finally {
    ctx.opruimen();
  }
});

const mollieFactuur: MollieSalesInvoice = {
  id: "invoice_abc",
  invoiceNumber: "2026-0042",
  status: "paid",
  vatMode: "exclusive",
  recipient: { type: "business", organizationName: "Klant B.V.", email: "boekhouding@klant.nl", vatNumber: "NL123456789B01", country: "NL" },
  lines: [
    { description: "Website onderhoud", quantity: 2, vatRate: "21.00", unitPrice: { currency: "EUR", value: "100.00" } },
    { description: "Boek", quantity: 1, vatRate: "9.00", unitPrice: { currency: "EUR", value: "20.00" }, discount: { type: "percentage", value: "10" } },
  ],
  subtotalAmount: { currency: "EUR", value: "218.00" },
  totalVatAmount: { currency: "EUR", value: "43.62" },
  totalAmount: { currency: "EUR", value: "261.62" },
  issuedAt: "2026-10-02T10:00:00+00:00",
  paidAt: "2026-10-03T08:00:00+00:00",
  dueAt: "2026-10-16",
  paymentDetails: [{ source: "payment", sourceReference: "tr_123" }],
};

test("Mollie: regels, BTW-codes en aansluiting op totalen", async () => {
  const ctx = await testCtx();
  try {
    assert.equal(mollieBtwCode("21.00", "NL", false), "NL21");
    assert.equal(mollieBtwCode("0.00", "BE", true), "EU_DIENST");
    assert.equal(mollieBtwCode("0.00", "US", false), "BUITEN_EU");
    const regels = vertaalMollieFactuur(ctx, mollieFactuur, null);
    assert.deepEqual(regels.map((r) => [r.bedrag_excl, r.btw_code, r.btw_bedrag]), [[20000, "NL21", 4200], [1800, "NL9", 162]]);

    const res = await syncVerkoopfacturen(ctx, [mollieFactuur, { ...mollieFactuur, id: "invoice_draft", status: "draft" }]);
    assert.deepEqual([res.nieuw, res.overgeslagen], [1, 1]);
    const f = ctx.db.get<{ id: number; status: string; totaal_incl: number; relatie_id: number; mollie_betaalreferenties: string }>("SELECT * FROM verkoopfacturen WHERE mollie_id = 'invoice_abc'")!;
    assert.equal(f.status, "geboekt");
    assert.equal(f.totaal_incl, 26162);
    assert.equal(f.mollie_betaalreferenties, '["tr_123"]');
    assert.equal(haalFactuur(ctx, "verkoop", f.id)!.betaalstatus, "betaald");
    // Tweede sync: niets nieuws
    const res2 = await syncVerkoopfacturen(ctx, [mollieFactuur]);
    assert.deepEqual([res2.nieuw, res2.bijgewerkt], [0, 0]);
    // Geannuleerd in Mollie -> vervallen
    const res3 = await syncVerkoopfacturen(ctx, [{ ...mollieFactuur, status: "cancelled" }]);
    assert.equal(res3.bijgewerkt, 1);
    assert.equal(ctx.db.get<{ status: string }>("SELECT status FROM verkoopfacturen WHERE id = ?", [f.id])!.status, "vervallen");
  } finally {
    ctx.opruimen();
  }
});

test("Mollie vervangt een omgezet concept met hetzelfde factuurnummer (geen dubbele verkoop)", async () => {
  const ctx = await testCtx();
  try {
    ctx.db.run("INSERT INTO verkoopfacturen (factuurnummer, status, bron, totaal_incl) VALUES ('2026-0042', 'concept', 'handmatig', 26162)");
    const res = await syncVerkoopfacturen(ctx, [mollieFactuur]);
    assert.equal(res.nieuw, 1);
    const rijen = ctx.db.all<{ bron: string }>("SELECT bron FROM verkoopfacturen WHERE factuurnummer = '2026-0042'");
    assert.deepEqual(rijen.map((r) => r.bron), ["mollie"]);
  } finally {
    ctx.opruimen();
  }
});

test("Mollie: één afwijkende factuur stopt de synchronisatie niet", async () => {
  const ctx = await testCtx();
  try {
    const kapot = { ...mollieFactuur, id: "invoice_kapot", invoiceNumber: "2026-0099", lines: [{ description: "x", quantity: 1, unitPrice: { currency: "EUR", value: "10.00" } }] } as unknown as MollieSalesInvoice;
    const res = await syncVerkoopfacturen(ctx, [kapot, mollieFactuur]);
    assert.equal(res.nieuw, 1);
    assert.equal(res.fouten, 1);
    assert.match(res.waarschuwingen.join(" "), /2026-0099 niet verwerkt/);
  } finally {
    ctx.opruimen();
  }
});

test("Mollie: paginagrootte maximaal 100 en alle pagina's worden opgehaald", async () => {
  const ctx = await testCtx({ MOLLIE_TOKEN: "access_test1234567890" });
  const origineel = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    const limit = Number(url.searchParams.get("limit"));
    if (!(limit >= 1 && limit <= 100)) return new Response(JSON.stringify({ status: 422, detail: "The limit should be a number between 1 and 100" }), { status: 422 });
    const tweede = url.searchParams.has("from");
    const inv = { ...mollieFactuur, id: tweede ? "invoice_2" : "invoice_1", invoiceNumber: tweede ? "2026-0002" : "2026-0001", _links: {} };
    return new Response(JSON.stringify({
      _embedded: { sales_invoices: [inv] },
      _links: { next: tweede ? null : { href: "https://api.mollie.com/v2/sales-invoices?from=invoice_2&limit=100" } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const res = await syncVerkoopfacturen(ctx);
    assert.equal(res.nieuw, 2);
    assert.ok(urls.every((u) => Number(new URL(u).searchParams.get("limit")) <= 100));
  } finally {
    globalThis.fetch = origineel;
    ctx.opruimen();
  }
});

test("Mollie: geannuleerde/verlopen facturen niet importeren; eerder geboekte blijven als geannuleerd", async () => {
  const ctx = await testCtx();
  try {
    const nooitGeboekt = { ...mollieFactuur, id: "invoice_weg", invoiceNumber: "2026-0100", status: "cancelled" };
    const verlopen = { ...mollieFactuur, id: "invoice_verlopen", invoiceNumber: "2026-0101", status: "expired" };
    let res = await syncVerkoopfacturen(ctx, [nooitGeboekt, verlopen]);
    assert.equal(res.nieuw, 0);
    assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM verkoopfacturen")!.n, 0);

    // Eerst uitgegeven (geboekt), daarna geannuleerd: blijft bewaard als 'vervallen'
    await syncVerkoopfacturen(ctx, [{ ...mollieFactuur, status: "issued" }]);
    res = await syncVerkoopfacturen(ctx, [{ ...mollieFactuur, status: "cancelled" }]);
    assert.equal(ctx.db.get<{ status: string }>("SELECT status FROM verkoopfacturen WHERE mollie_id = 'invoice_abc'")!.status, "vervallen");

    // Oud geïmporteerd 'vervallen' zonder ooit geboekt te zijn: wordt opgeruimd
    ctx.db.run("INSERT INTO verkoopfacturen (factuurnummer, status, bron, mollie_id) VALUES ('oud', 'vervallen', 'mollie', 'invoice_oud')");
    await syncVerkoopfacturen(ctx, []);
    assert.equal(ctx.db.get("SELECT id FROM verkoopfacturen WHERE mollie_id = 'invoice_oud'"), undefined);
    assert.ok(ctx.db.get("SELECT id FROM verkoopfacturen WHERE mollie_id = 'invoice_abc'"));
  } finally {
    ctx.opruimen();
  }
});
