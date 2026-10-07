import type { Ctx } from "../../lib/context.ts";
import { audit, GebruikersFout } from "../../lib/context.ts";
import { bewaarBijlage, detecteerType } from "../../lib/bijlagen.ts";
import { parseBedrag } from "../../lib/geld.ts";
import { btwCodeMap, isAfgesloten, regelBtw } from "../../modules/btw/service.ts";
import { categorieen, normaliseerBtwNummer, zoekRelatieMatch } from "../../modules/relaties/service.ts";

const API = "https://api.mollie.com/v2";
const EU = new Set(["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "PL", "PT", "RO", "SE", "SI", "SK"]);

export interface MollieBedrag {
  currency: string;
  value: string;
}

export interface MollieSalesInvoice {
  id: string;
  invoiceNumber?: string | null;
  status: string;
  vatScheme?: string;
  vatMode?: "exclusive" | "inclusive";
  memo?: string | null;
  recipient?: {
    type?: "consumer" | "business";
    givenName?: string | null;
    familyName?: string | null;
    organizationName?: string | null;
    organizationNumber?: string | null;
    vatNumber?: string | null;
    email?: string | null;
    streetAndNumber?: string | null;
    postalCode?: string | null;
    city?: string | null;
    country?: string | null;
  };
  lines?: { description: string; quantity: number; vatRate: string; unitPrice: MollieBedrag; discount?: { type: "amount" | "percentage"; value: string } | null }[];
  discount?: { type: "amount" | "percentage"; value: string } | null;
  subtotalAmount?: MollieBedrag;
  discountedSubtotalAmount?: MollieBedrag | null;
  totalVatAmount?: MollieBedrag;
  totalAmount?: MollieBedrag;
  createdAt?: string;
  issuedAt?: string | null;
  paidAt?: string | null;
  dueAt?: string | null;
  paymentDetails?: { source: string; sourceReference?: string | null }[];
  _links?: { pdfLink?: { href: string } | null };
}

export function mollieIngesteld(ctx: Ctx): boolean {
  return !!ctx.config.MOLLIE_TOKEN;
}

async function mollie<T>(ctx: Ctx, pad: string, poging = 0): Promise<T> {
  const url = new URL(pad.startsWith("http") ? pad : `${API}${pad}`);
  if (ctx.config.MOLLIE_TESTMODE && !url.searchParams.has("testmode")) url.searchParams.set("testmode", "true");
  if (url.origin !== "https://api.mollie.com") throw new Error("Onverwachte Mollie-URL");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${ctx.config.MOLLIE_TOKEN}` }, signal: AbortSignal.timeout(60_000) });
  if ((res.status === 429 || res.status >= 500) && poging < 4) {
    await new Promise((r) => setTimeout(r, 2 ** poging * 1000));
    return mollie<T>(ctx, pad, poging + 1);
  }
  if (res.status === 401 || res.status === 403) {
    throw new GebruikersFout(`Mollie weigert toegang (${res.status}) voor ${url.pathname}. Controleer het token en de rechten (sales-invoices.read, settlements.read).`, 502);
  }
  if (!res.ok) throw new Error(`Mollie ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Haalt alle items van een gepagineerde Mollie-lijst op. */
async function alles<T>(ctx: Ctx, pad: string, max = 5000): Promise<T[]> {
  const uit: T[] = [];
  let volgende: string | null = pad;
  while (volgende && uit.length < max) {
    const r: { _embedded?: Record<string, T[]>; _links?: { next?: { href: string } | null } } = await mollie(ctx, volgende);
    const lijst = Object.values(r._embedded ?? {}).find(Array.isArray) ?? [];
    uit.push(...lijst);
    volgende = r._links?.next?.href ?? null;
  }
  return uit;
}

const centen = (b?: MollieBedrag | null): number => (b ? parseBedrag(b.value, ".") ?? 0 : 0);
const datumDeel = (s?: string | null): string | null => (s ? s.slice(0, 10) : null);

/** BTW-code voor een Mollie-regel op basis van tarief en ontvanger. */
export function mollieBtwCode(vatRate: string, land: string | null | undefined, zakelijkMetBtwNummer: boolean): string {
  const tarief = Number.parseFloat(vatRate);
  if (Math.abs(tarief - 21) < 0.01) return "NL21";
  if (Math.abs(tarief - 9) < 0.01) return "NL9";
  if (tarief === 0) {
    const lc = (land || "NL").toUpperCase();
    if (lc === "NL") return "NL0";
    if (EU.has(lc)) return zakelijkMetBtwNummer ? "EU_DIENST" : "NL0";
    return "BUITEN_EU";
  }
  return "NL21"; // OSS-tarieven van andere lidstaten: handmatig controleren
}

/** Zet een Mollie-factuur om naar regels met BTW-codes; sluit exact aan op de totalen van Mollie. */
export function vertaalMollieFactuur(ctx: Ctx, inv: MollieSalesInvoice, omzetCategorieId: number | null) {
  const codes = btwCodeMap(ctx.db);
  const rec = inv.recipient ?? {};
  const zakelijk = rec.type === "business" && !!rec.vatNumber;
  const inclusief = inv.vatMode === "inclusive";
  const regels = (inv.lines ?? []).map((l) => {
    if (typeof l.vatRate !== "string" || !/^\d{1,2}(\.\d+)?$/.test(l.vatRate.trim())) {
      throw new Error(`regel "${l.description ?? "?"}" heeft geen geldig BTW-tarief (${String(l.vatRate)})`);
    }
    const code = mollieBtwCode(l.vatRate, rec.country, zakelijk);
    let bedrag = centen(l.unitPrice) * (l.quantity || 1);
    if (l.discount) {
      bedrag -= l.discount.type === "percentage" ? Math.round((bedrag * Number.parseFloat(l.discount.value)) / 100) : (parseBedrag(l.discount.value, ".") ?? 0);
    }
    const tariefBp = Math.round(Number.parseFloat(l.vatRate) * 100);
    const excl = inclusief ? Math.round((bedrag * 10000) / (10000 + tariefBp)) : bedrag;
    return {
      omschrijving: l.description?.slice(0, 500) ?? null,
      categorie_id: omzetCategorieId,
      bedrag_excl: excl,
      btw_code: code,
      btw_bedrag: regelBtw(codes.get(code)!, excl, inclusief ? bedrag - excl : null),
    };
  });

  if (regels.some((r) => !Number.isFinite(r.bedrag_excl) || !Number.isFinite(r.btw_bedrag))) {
    throw new Error("onverwachte of ontbrekende bedragen/BTW-tarieven in de factuurregels");
  }
  // Aansluiten op de totalen van Mollie (factuurkorting, afronding)
  const doelExcl = centen(inv.discountedSubtotalAmount ?? inv.subtotalAmount);
  const doelBtw = centen(inv.totalVatAmount);
  const somExcl = regels.reduce((s, r) => s + r.bedrag_excl, 0);
  if (regels.length && inv.subtotalAmount && doelExcl !== somExcl) {
    const code = regels[0].btw_code;
    const verschil = doelExcl - somExcl;
    regels.push({ omschrijving: "Korting / afronding (Mollie)", categorie_id: omzetCategorieId, bedrag_excl: verschil, btw_code: code, btw_bedrag: regelBtw(codes.get(code)!, verschil) });
  }
  const somBtw = regels.reduce((s, r) => s + r.btw_bedrag, 0);
  if (regels.length && inv.totalVatAmount && doelBtw !== somBtw) {
    const i = regels.findIndex((r) => !codes.get(r.btw_code)?.verlegd && codes.get(r.btw_code)!.tarief_bp > 0);
    if (i >= 0) regels[i].btw_bedrag += doelBtw - somBtw;
  }
  return regels;
}

function relatieVoorOntvanger(ctx: Ctx, inv: MollieSalesInvoice): number | null {
  const r = inv.recipient;
  if (!r) return null;
  const naam = r.organizationName || [r.givenName, r.familyName].filter(Boolean).join(" ") || r.email || "Onbekende klant";
  if (r.email) {
    const opMail = ctx.db.get<{ id: number }>("SELECT id FROM relaties WHERE lower(email) = lower(?) LIMIT 1", [r.email]);
    if (opMail) return opMail.id;
  }
  const match = zoekRelatieMatch(ctx, { btw_nummer: r.vatNumber, naam });
  if (match) {
    if (match.type === "leverancier") ctx.db.run("UPDATE relaties SET type = 'beide' WHERE id = ?", [match.id]);
    return match.id;
  }
  const id = ctx.db.run(
    `INSERT INTO relaties (naam, type, kvk, btw_nummer, email, adres, postcode, plaats, land, notities) VALUES (?, 'klant', ?, ?, ?, ?, ?, ?, ?, 'Aangemaakt vanuit Mollie')`,
    [naam, r.organizationNumber ?? null, r.vatNumber ? normaliseerBtwNummer(r.vatNumber) : null, r.email ?? null, r.streetAndNumber ?? null, r.postalCode ?? null, r.city ?? null, (r.country ?? "NL").toUpperCase()],
  ).id;
  audit(ctx.db, "mollie", "aangemaakt", "relaties", id, { bron: "mollie", factuur: inv.id });
  return id;
}

function statusVoorMollie(s: string): "geboekt" | "vervallen" | null {
  if (["issued", "pending-payment", "paid", "overdue", "payment_reversed"].includes(s)) return "geboekt";
  if (["cancelled", "expired", "failed"].includes(s)) return "vervallen";
  return null; // draft / issuing: nog niet boeken
}

async function haalPdf(ctx: Ctx, inv: MollieSalesInvoice): Promise<string | null> {
  const href = inv._links?.pdfLink?.href;
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "https:") return null;
    const headers: Record<string, string> = url.hostname.endsWith("mollie.com") ? { Authorization: `Bearer ${ctx.config.MOLLIE_TOKEN}` } : {};
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (detecteerType(data)?.mime !== "application/pdf") return null;
    return bewaarBijlage(ctx, data, `${inv.invoiceNumber ?? inv.id}.pdf`).sha256;
  } catch (e) {
    ctx.log.warn(`Mollie-PDF ${inv.id} niet opgehaald: ${(e as Error).message}`);
    return null;
  }
}

export interface MollieSyncResultaat {
  nieuw: number;
  bijgewerkt: number;
  overgeslagen: number;
  fouten: number;
  waarschuwingen: string[];
}

/** Importeert/actualiseert verkoopfacturen uit Mollie Facturatie. */
export async function syncVerkoopfacturen(ctx: Ctx, facturen?: MollieSalesInvoice[]): Promise<MollieSyncResultaat> {
  const lijst = facturen ?? (await alles<MollieSalesInvoice>(ctx, "/sales-invoices?limit=250"));
  const omzet = categorieen(ctx).find((c) => c.soort === "omzet")?.id ?? null;
  const res: MollieSyncResultaat = { nieuw: 0, bijgewerkt: 0, overgeslagen: 0, fouten: 0, waarschuwingen: [] };

  // Eén afwijkende factuur mag de rest niet tegenhouden
  const verwerkEen = async (inv: MollieSalesInvoice): Promise<void> => {
    const status = statusVoorMollie(inv.status);
    const bestaand = ctx.db.get<{ id: number; status: string; factuurdatum: string | null; totaal_incl: number; bijlage_sha256: string | null; mollie_status: string }>(
      "SELECT id, status, factuurdatum, totaal_incl, bijlage_sha256, mollie_status FROM verkoopfacturen WHERE mollie_id = ?",
      [inv.id],
    );
    if (!status) {
      res.overgeslagen++;
      return;
    }
    const factuurdatum = datumDeel(inv.issuedAt) ?? datumDeel(inv.createdAt);
    const regels = vertaalMollieFactuur(ctx, inv, omzet);
    const excl = regels.reduce((s, r) => s + r.bedrag_excl, 0);
    const btw = regels.reduce((s, r) => s + r.btw_bedrag, 0);
    const referenties = JSON.stringify((inv.paymentDetails ?? []).map((p) => p.sourceReference).filter(Boolean));

    if (bestaand) {
      const bedragGewijzigd = bestaand.totaal_incl !== excl + btw;
      const statusGewijzigd = bestaand.status !== status;
      if ((bedragGewijzigd || statusGewijzigd) && bestaand.status === "geboekt" && isAfgesloten(ctx.db, bestaand.factuurdatum)) {
        res.waarschuwingen.push(`Mollie-factuur ${inv.invoiceNumber ?? inv.id} is gewijzigd (${inv.status}) maar valt in een afgesloten periode; niet aangepast. Corrigeer via een creditfactuur.`);
        ctx.db.run("UPDATE verkoopfacturen SET mollie_status = ?, mollie_betaald_op = ?, mollie_betaalreferenties = ? WHERE id = ?", [inv.status, datumDeel(inv.paidAt), referenties, bestaand.id]);
        return;
      }
      const pdf = bestaand.bijlage_sha256 ?? (await haalPdf(ctx, inv));
      ctx.db.tx(() => {
        ctx.db.run(
          `UPDATE verkoopfacturen SET factuurnummer = ?, factuurdatum = ?, vervaldatum = ?, omschrijving = ?, totaal_excl = ?, totaal_btw = ?, totaal_incl = ?,
             status = ?, mollie_status = ?, mollie_betaald_op = ?, mollie_betaalreferenties = ?, bijlage_sha256 = ?, gewijzigd_op = ? WHERE id = ?`,
          [inv.invoiceNumber ?? null, factuurdatum, datumDeel(inv.dueAt), inv.memo?.slice(0, 1000) ?? null, excl, btw, excl + btw, status, inv.status, datumDeel(inv.paidAt), referenties, pdf, new Date().toISOString(), bestaand.id],
        );
        if (bedragGewijzigd) {
          // Categorieën per regel behouden waar mogelijk
          const oudeCats = ctx.db.all<{ categorie_id: number | null }>("SELECT categorie_id FROM verkoopfactuur_regels WHERE factuur_id = ? ORDER BY volgorde", [bestaand.id]);
          ctx.db.run("DELETE FROM verkoopfactuur_regels WHERE factuur_id = ?", [bestaand.id]);
          regels.forEach((r, i) =>
            ctx.db.run("INSERT INTO verkoopfactuur_regels (factuur_id, volgorde, omschrijving, categorie_id, bedrag_excl, btw_code, btw_bedrag) VALUES (?, ?, ?, ?, ?, ?, ?)", [
              bestaand.id, i, r.omschrijving, oudeCats[i]?.categorie_id ?? r.categorie_id, r.bedrag_excl, r.btw_code, r.btw_bedrag,
            ]),
          );
        }
        if (bedragGewijzigd || statusGewijzigd || bestaand.mollie_status !== inv.status) {
          audit(ctx.db, "mollie", "bijgewerkt", "verkoopfacturen", bestaand.id, { mollie_status: inv.status });
          res.bijgewerkt++;
        }
      });
      return;
    }

    // Bestaat dit factuurnummer al als handmatige verkoopfactuur (bv. omgezet vanuit de inkoop)?
    if (inv.invoiceNumber) {
      const handmatig = ctx.db.get<{ id: number; status: string }>(
        "SELECT id, status FROM verkoopfacturen WHERE factuurnummer = ? AND bron = 'handmatig' LIMIT 1",
        [inv.invoiceNumber],
      );
      if (handmatig?.status === "geboekt") {
        res.waarschuwingen.push(`Mollie-factuur ${inv.invoiceNumber} staat al als handmatig geboekte verkoopfactuur (#${handmatig.id}); niet dubbel geïmporteerd.`);
        res.overgeslagen++;
        return;
      }
      if (handmatig && !ctx.db.get("SELECT 1 FROM transactie_koppelingen WHERE verkoopfactuur_id = ?", [handmatig.id])) {
        ctx.db.run("DELETE FROM verkoopfacturen WHERE id = ?", [handmatig.id]);
        audit(ctx.db, "mollie", "concept_vervangen_door_mollie", "verkoopfacturen", handmatig.id, { mollie_id: inv.id });
      }
    }

    const relatieId = relatieVoorOntvanger(ctx, inv);
    const pdf = await haalPdf(ctx, inv);
    if (status === "geboekt" && isAfgesloten(ctx.db, factuurdatum)) {
      res.waarschuwingen.push(`Mollie-factuur ${inv.invoiceNumber ?? inv.id} (${factuurdatum}) valt in een afgesloten periode en is als concept geïmporteerd.`);
    }
    const effectief = status === "geboekt" && isAfgesloten(ctx.db, factuurdatum) ? "concept" : status;
    ctx.db.tx(() => {
      const id = ctx.db.run(
        `INSERT INTO verkoopfacturen (relatie_id, factuurnummer, factuurdatum, vervaldatum, omschrijving, totaal_excl, totaal_btw, totaal_incl, status, bron,
           mollie_id, mollie_status, mollie_betaald_op, mollie_betaalreferenties, bijlage_sha256, geboekt_op)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'mollie', ?, ?, ?, ?, ?, ?)`,
        [relatieId, inv.invoiceNumber ?? null, factuurdatum, datumDeel(inv.dueAt), inv.memo?.slice(0, 1000) ?? null, excl, btw, excl + btw, effectief,
          inv.id, inv.status, datumDeel(inv.paidAt), referenties, pdf, effectief === "geboekt" ? new Date().toISOString() : null],
      ).id;
      regels.forEach((r, i) =>
        ctx.db.run("INSERT INTO verkoopfactuur_regels (factuur_id, volgorde, omschrijving, categorie_id, bedrag_excl, btw_code, btw_bedrag) VALUES (?, ?, ?, ?, ?, ?, ?)", [
          id, i, r.omschrijving, r.categorie_id, r.bedrag_excl, r.btw_code, r.btw_bedrag,
        ]),
      );
      audit(ctx.db, "mollie", "geimporteerd", "verkoopfacturen", id, { mollie_id: inv.id, status: inv.status });
    });
    res.nieuw++;
  };
  for (const inv of lijst) {
    try {
      await verwerkEen(inv);
    } catch (e) {
      res.fouten++;
      res.waarschuwingen.push(`Mollie-factuur ${inv.invoiceNumber ?? inv.id} niet verwerkt: ${(e as Error).message}`);
    }
  }
  return res;
}

// ---------------- Uitbetalingen (settlements) ----------------

interface MollieSettlement {
  id: string;
  reference?: string | null;
  status: string;
  amount: MollieBedrag;
  settledAt?: string | null;
  createdAt?: string;
  periods?: Record<string, Record<string, { costs?: { amountGross?: MollieBedrag }[]; invoiceId?: string | null }>>;
}

interface MolliePayment {
  id: string;
  description?: string;
  amount: MollieBedrag;
  status: string;
}

export async function syncUitbetalingen(ctx: Ctx): Promise<{ uitbetalingen: number; gekoppeldeFacturen: number }> {
  const settlements = await alles<MollieSettlement>(ctx, "/settlements?limit=250", 1000);
  let gekoppeld = 0;
  let n = 0;
  for (const s of settlements) {
    if (!["paidout", "processing-at-bank", "pending", "processing"].includes(s.status)) continue;
    let kosten = 0;
    let factuurId: string | null = null;
    for (const jaar of Object.values(s.periods ?? {})) {
      for (const maand of Object.values(jaar)) {
        for (const c of maand.costs ?? []) kosten += centen(c.amountGross);
        factuurId ??= maand.invoiceId ?? null;
      }
    }
    const bestaand = ctx.db.get<{ id: number; status: string }>("SELECT id, status FROM mollie_uitbetalingen WHERE mollie_id = ?", [s.id]);
    let uitId: number;
    if (bestaand) {
      if (bestaand.status === s.status) continue; // ongewijzigd
      ctx.db.run("UPDATE mollie_uitbetalingen SET status = ?, bedrag = ?, kosten = ?, mollie_factuur_id = ?, uitbetaald_op = ? WHERE id = ?", [
        s.status, centen(s.amount), kosten, factuurId, datumDeel(s.settledAt), bestaand.id,
      ]);
      uitId = bestaand.id;
    } else {
      uitId = ctx.db.run("INSERT INTO mollie_uitbetalingen (mollie_id, referentie, status, bedrag, kosten, mollie_factuur_id, uitbetaald_op) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        s.id, s.reference ?? null, s.status, centen(s.amount), kosten, factuurId, datumDeel(s.settledAt),
      ]).id;
    }
    n++;
    // Welke verkoopfacturen zitten in deze uitbetaling?
    const betalingen = await alles<MolliePayment>(ctx, `/settlements/${s.id}/payments?limit=250`, 5000);
    const facturen = ctx.db.all<{ id: number; factuurnummer: string | null; totaal_incl: number; mollie_betaalreferenties: string | null }>(
      "SELECT id, factuurnummer, totaal_incl, mollie_betaalreferenties FROM verkoopfacturen WHERE bron = 'mollie'",
    );
    ctx.db.tx(() => {
      ctx.db.run("DELETE FROM mollie_uitbetaling_facturen WHERE uitbetaling_id = ?", [uitId]);
      for (const p of betalingen) {
        if (p.status !== "paid") continue;
        const f =
          facturen.find((f) => (JSON.parse(f.mollie_betaalreferenties ?? "[]") as string[]).includes(p.id)) ??
          facturen.find((f) => f.factuurnummer && p.description?.includes(f.factuurnummer) && f.totaal_incl === centen(p.amount));
        if (!f) continue;
        ctx.db.run("INSERT OR IGNORE INTO mollie_uitbetaling_facturen (uitbetaling_id, verkoopfactuur_id, bedrag) VALUES (?, ?, ?)", [uitId, f.id, centen(p.amount)]);
        gekoppeld++;
      }
    });
  }
  return { uitbetalingen: n, gekoppeldeFacturen: gekoppeld };
}

export async function syncMollie(ctx: Ctx): Promise<string> {
  const r = await syncVerkoopfacturen(ctx);
  let uit = "";
  try {
    const u = await syncUitbetalingen(ctx);
    uit = `, ${u.uitbetalingen} uitbetaling(en) bijgewerkt`;
  } catch (e) {
    uit = ` (uitbetalingen niet opgehaald: ${(e as Error).message})`;
  }
  for (const w of r.waarschuwingen) ctx.log.warn(w);
  return `${r.nieuw} nieuw, ${r.bijgewerkt} bijgewerkt${r.fouten ? `, ${r.fouten} met fout` : ""}${uit}${r.waarschuwingen.length ? `; ${r.waarschuwingen.length} waarschuwing(en): ${r.waarschuwingen.join(" | ")}` : ""}`;
}
