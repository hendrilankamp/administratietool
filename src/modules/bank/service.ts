import type { Ctx } from "../../lib/context.ts";
import { audit, GebruikersFout } from "../../lib/context.ts";
import { dagenVerschil, isGeldigeDatum } from "../../lib/datum.ts";
import { normaliseerIban } from "../relaties/service.ts";

export interface Rekening {
  id: number;
  naam: string;
  iban: string;
  bank: string | null;
  beginsaldo: number;
  begindatum: string;
}

export interface Transactie {
  id: number;
  rekening_id: number;
  boekdatum: string;
  valutadatum: string | null;
  bedrag: number;
  valuta: string;
  tegenpartij_naam: string | null;
  tegenpartij_iban: string | null;
  omschrijving: string | null;
  type: string | null;
  import_batch_id: number | null;
  status: "open" | "gekoppeld" | "geboekt_zonder_factuur";
  categorie_id: number | null;
  notitie: string | null;
  gekoppeld_bedrag?: number;
}

export interface Koppeling {
  id: number;
  transactie_id: number;
  inkoopfactuur_id: number | null;
  verkoopfactuur_id: number | null;
  bedrag: number;
  automatisch: number;
}

// ---------- Rekeningen ----------

export function rekeningen(ctx: Ctx): Rekening[] {
  return ctx.db.all<Rekening>("SELECT * FROM bankrekeningen ORDER BY naam");
}

export function slaRekeningOp(ctx: Ctx, id: number | null, d: { naam: string; iban: string; bank?: string | null; beginsaldo: number; begindatum: string }, gebruiker: string): number {
  if (!d.naam.trim()) throw new GebruikersFout("Naam is verplicht");
  const iban = normaliseerIban(d.iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(iban)) throw new GebruikersFout("Ongeldig IBAN");
  if (!isGeldigeDatum(d.begindatum)) throw new GebruikersFout("Ongeldige begindatum");
  if (id === null) {
    const r = ctx.db.run("INSERT INTO bankrekeningen (naam, iban, bank, beginsaldo, begindatum) VALUES (?, ?, ?, ?, ?)", [d.naam.trim(), iban, d.bank ?? null, d.beginsaldo, d.begindatum]);
    audit(ctx.db, gebruiker, "aangemaakt", "bankrekeningen", r.id, d);
    return r.id;
  }
  ctx.db.run("UPDATE bankrekeningen SET naam = ?, iban = ?, bank = ?, beginsaldo = ?, begindatum = ? WHERE id = ?", [d.naam.trim(), iban, d.bank ?? null, d.beginsaldo, d.begindatum, id]);
  audit(ctx.db, gebruiker, "gewijzigd", "bankrekeningen", id, d);
  return id;
}

export function saldoOp(ctx: Ctx, rekeningId: number, datum: string): number {
  const r = ctx.db.get<Rekening>("SELECT * FROM bankrekeningen WHERE id = ?", [rekeningId]);
  if (!r) throw new GebruikersFout("Rekening niet gevonden", 404);
  const som = ctx.db.get<{ s: number | null }>("SELECT SUM(bedrag) AS s FROM banktransacties WHERE rekening_id = ? AND boekdatum > ? AND boekdatum <= ?", [rekeningId, r.begindatum, datum])!.s ?? 0;
  return r.beginsaldo + som;
}

export interface SaldoControle {
  id: number;
  datum: string;
  saldo: number;
  berekend: number;
  verschil: number;
}

export function saldoControles(ctx: Ctx, rekeningId: number): SaldoControle[] {
  return ctx.db
    .all<{ id: number; datum: string; saldo: number }>("SELECT id, datum, saldo FROM saldo_controles WHERE rekening_id = ? ORDER BY datum DESC LIMIT 24", [rekeningId])
    .map((c) => {
      const berekend = saldoOp(ctx, rekeningId, c.datum);
      return { ...c, berekend, verschil: c.saldo - berekend };
    });
}

export function voegSaldoControleToe(ctx: Ctx, rekeningId: number, datum: string, saldo: number, gebruiker: string): SaldoControle {
  if (!isGeldigeDatum(datum)) throw new GebruikersFout("Ongeldige datum");
  const id = ctx.db.run("INSERT INTO saldo_controles (rekening_id, datum, saldo) VALUES (?, ?, ?)", [rekeningId, datum, saldo]).id;
  audit(ctx.db, gebruiker, "saldo_controle", "bankrekeningen", rekeningId, { datum, saldo });
  const berekend = saldoOp(ctx, rekeningId, datum);
  return { id, datum, saldo, berekend, verschil: saldo - berekend };
}

// ---------- Transacties ----------

export function transacties(ctx: Ctx, filter: { status?: string; rekeningId?: number; zoek?: string; van?: string; tot?: string; limiet?: number } = {}): Transactie[] {
  const waar: string[] = [];
  const p: (string | number)[] = [];
  if (filter.status) {
    waar.push("t.status = ?");
    p.push(filter.status);
  }
  if (filter.rekeningId) {
    waar.push("t.rekening_id = ?");
    p.push(filter.rekeningId);
  }
  if (filter.zoek) {
    waar.push("(t.tegenpartij_naam LIKE ? OR t.omschrijving LIKE ? OR t.tegenpartij_iban LIKE ?)");
    const z = `%${filter.zoek}%`;
    p.push(z, z, z);
  }
  if (filter.van) {
    waar.push("t.boekdatum >= ?");
    p.push(filter.van);
  }
  if (filter.tot) {
    waar.push("t.boekdatum <= ?");
    p.push(filter.tot);
  }
  p.push(filter.limiet ?? 500);
  return ctx.db.all<Transactie>(
    `SELECT t.*, COALESCE((SELECT SUM(k.bedrag) FROM transactie_koppelingen k WHERE k.transactie_id = t.id), 0) AS gekoppeld_bedrag
     FROM banktransacties t ${waar.length ? `WHERE ${waar.join(" AND ")}` : ""} ORDER BY t.boekdatum DESC, t.id DESC LIMIT ?`,
    p,
  );
}

export function haalTransactie(ctx: Ctx, id: number): (Transactie & { koppelingen: (Koppeling & { soort: "inkoop" | "verkoop"; factuurnummer: string | null; relatie_naam: string | null })[] }) | null {
  const t = ctx.db.get<Transactie>("SELECT * FROM banktransacties WHERE id = ?", [id]);
  if (!t) return null;
  const koppelingen = ctx.db.all<Koppeling & { soort: "inkoop" | "verkoop"; factuurnummer: string | null; relatie_naam: string | null }>(
    `SELECT k.*, CASE WHEN k.inkoopfactuur_id IS NOT NULL THEN 'inkoop' ELSE 'verkoop' END AS soort,
            COALESCE(i.factuurnummer, v.factuurnummer) AS factuurnummer, r.naam AS relatie_naam
     FROM transactie_koppelingen k
     LEFT JOIN inkoopfacturen i ON i.id = k.inkoopfactuur_id
     LEFT JOIN verkoopfacturen v ON v.id = k.verkoopfactuur_id
     LEFT JOIN relaties r ON r.id = COALESCE(i.relatie_id, v.relatie_id)
     WHERE k.transactie_id = ? ORDER BY k.id`,
    [id],
  );
  const gekoppeld_bedrag = koppelingen.reduce((s, k) => s + k.bedrag, 0);
  return { ...t, gekoppeld_bedrag, koppelingen };
}

// ---------- Open posten en voorstellen ----------

export interface OpenPost {
  soort: "inkoop" | "verkoop";
  id: number;
  relatie_id: number | null;
  relatie_naam: string | null;
  relatie_iban: string | null;
  factuurnummer: string | null;
  factuurdatum: string | null;
  vervaldatum: string | null;
  totaal_incl: number;
  /** Nog te ontvangen/betalen via de bank (factuurperspectief, positief bij normale factuur). */
  open: number;
  /** Bedrag zoals het op de bank zou verschijnen (verkoop +, inkoop −). */
  bankBedrag: number;
  mollie: boolean;
}

export function openPosten(ctx: Ctx): OpenPost[] {
  const verkoop = ctx.db.all<OpenPost>(
    `SELECT 'verkoop' AS soort, f.id, f.relatie_id, r.naam AS relatie_naam, r.iban AS relatie_iban, f.factuurnummer, f.factuurdatum, f.vervaldatum, f.totaal_incl,
            f.totaal_incl - COALESCE(o.ontvangen_bank, 0) AS open, f.bron = 'mollie' AS mollie
     FROM verkoopfacturen f LEFT JOIN relaties r ON r.id = f.relatie_id LEFT JOIN v_verkoop_ontvangen o ON o.factuur_id = f.id
     WHERE f.status = 'geboekt' AND f.betaald_handmatig_op IS NULL AND f.totaal_incl - COALESCE(o.ontvangen_bank, 0) <> 0`,
  );
  const inkoop = ctx.db.all<OpenPost>(
    `SELECT 'inkoop' AS soort, f.id, f.relatie_id, r.naam AS relatie_naam, r.iban AS relatie_iban, f.factuurnummer, f.factuurdatum, f.vervaldatum, f.totaal_incl,
            f.totaal_incl - COALESCE(b.betaald_bank, 0) AS open, 0 AS mollie
     FROM inkoopfacturen f LEFT JOIN relaties r ON r.id = f.relatie_id LEFT JOIN v_inkoop_betaald b ON b.factuur_id = f.id
     WHERE f.status = 'geboekt' AND f.betaald_handmatig_op IS NULL AND f.totaal_incl - COALESCE(b.betaald_bank, 0) <> 0`,
  );
  return [...verkoop, ...inkoop].map((p) => ({ ...p, mollie: !!p.mollie, bankBedrag: p.soort === "verkoop" ? p.open : -p.open }));
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export interface Voorstel {
  soort: "factuur" | "mollie" | "regel";
  score: number;
  titel: string;
  redenen: string[];
  koppelingen: { soort: "inkoop" | "verkoop"; factuurId: number; bedrag: number; label: string }[];
  rest?: { categorieId: number; bedrag: number; label: string };
  categorieId?: number; // bij soort "regel": boeken zonder factuur
}

function isMollie(t: Transactie): boolean {
  return /mollie|stichting mollie payments/i.test(t.tegenpartij_naam ?? "") || /mollie/i.test(t.omschrijving ?? "");
}

/** Berekent een score (0-100+) voor een transactie tegen een open post. */
export function scoreMatch(t: Transactie, p: OpenPost): { score: number; redenen: string[] } {
  const redenen: string[] = [];
  let score = 0;
  // Richting moet kloppen
  if (Math.sign(t.bedrag) !== Math.sign(p.bankBedrag)) return { score: 0, redenen };
  const omschr = norm(`${t.omschrijving} ${t.tegenpartij_naam}`);
  const nr = norm(p.factuurnummer);
  if (nr.length >= 3 && omschr.includes(nr)) {
    score += 50;
    redenen.push("factuurnummer in omschrijving");
  }
  if (t.bedrag === p.bankBedrag) {
    score += 30;
    redenen.push("bedrag exact gelijk");
  } else if (Math.abs(t.bedrag) < Math.abs(p.bankBedrag)) {
    score += 5;
    redenen.push("mogelijk deelbetaling");
  }
  if (t.tegenpartij_iban && p.relatie_iban && normaliseerIban(t.tegenpartij_iban) === p.relatie_iban) {
    score += 25;
    redenen.push("IBAN van relatie");
  } else if (p.relatie_naam) {
    const a = norm(t.tegenpartij_naam);
    const b = norm(p.relatie_naam);
    if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) {
      score += 15;
      redenen.push("naam tegenpartij");
    }
  }
  const ref = p.vervaldatum ?? p.factuurdatum;
  if (ref) {
    const d = Math.abs(dagenVerschil(ref, t.boekdatum));
    if (d <= 30) score += 10;
    else if (d <= 90) score += 5;
  }
  return { score, redenen };
}

export function voorstellen(ctx: Ctx, t: Transactie, posten: OpenPost[] = openPosten(ctx)): Voorstel[] {
  const uit: Voorstel[] = [];
  const rest = t.bedrag - (ctx.db.get<{ s: number | null }>("SELECT SUM(bedrag) AS s FROM transactie_koppelingen WHERE transactie_id = ?", [t.id])!.s ?? 0);
  if (rest === 0) return uit;

  // 1. Mollie-uitbetaling
  if (isMollie(t) && t.bedrag > 0) {
    const kandidaten = ctx.db.all<{ id: number; referentie: string | null; bedrag: number; kosten: number; uitbetaald_op: string | null }>(
      "SELECT id, referentie, bedrag, kosten, uitbetaald_op FROM mollie_uitbetalingen ORDER BY uitbetaald_op DESC LIMIT 200",
    );
    const omschr = t.omschrijving ?? "";
    const u =
      kandidaten.find((k) => k.referentie && omschr.includes(k.referentie)) ??
      kandidaten.find((k) => k.bedrag === t.bedrag && (!k.uitbetaald_op || Math.abs(dagenVerschil(k.uitbetaald_op, t.boekdatum)) <= 10));
    if (u) {
      const facturen = ctx.db.all<{ verkoopfactuur_id: number; bedrag: number; factuurnummer: string | null }>(
        `SELECT mf.verkoopfactuur_id, mf.bedrag, f.factuurnummer FROM mollie_uitbetaling_facturen mf JOIN verkoopfacturen f ON f.id = mf.verkoopfactuur_id WHERE mf.uitbetaling_id = ?`,
        [u.id],
      );
      const openIds = new Map(posten.filter((p) => p.soort === "verkoop").map((p) => [p.id, p]));
      const koppelingen = facturen
        .filter((f) => openIds.has(f.verkoopfactuur_id))
        .map((f) => ({ soort: "verkoop" as const, factuurId: f.verkoopfactuur_id, bedrag: Math.min(f.bedrag, openIds.get(f.verkoopfactuur_id)!.open), label: `Verkoop ${f.factuurnummer ?? f.verkoopfactuur_id}` }));
      const som = koppelingen.reduce((s, k) => s + k.bedrag, 0);
      const verschil = t.bedrag - som; // negatief = ingehouden kosten
      const v: Voorstel = {
        soort: "mollie",
        score: 90,
        titel: `Mollie-uitbetaling ${u.referentie ?? ""}`.trim(),
        redenen: [`${koppelingen.length} factuur/facturen`, u.kosten ? `Mollie-kosten € ${(u.kosten / 100).toFixed(2)}` : ""].filter(Boolean),
        koppelingen,
      };
      if (verschil < 0) {
        // Ingehouden kosten: koppel aan een open Mollie-inkoopfactuur met precies dat bedrag, anders als restpost op categorie
        const mollieInkoop = posten.find((p) => p.soort === "inkoop" && /mollie/i.test(p.relatie_naam ?? "") && p.bankBedrag === verschil);
        if (mollieInkoop) v.koppelingen.push({ soort: "inkoop", factuurId: mollieInkoop.id, bedrag: verschil, label: `Mollie-factuur ${mollieInkoop.factuurnummer ?? mollieInkoop.id}` });
        else {
          const cat = ctx.db.get<{ id: number }>("SELECT id FROM categorieen WHERE naam LIKE 'Betaalprovider%' LIMIT 1");
          if (cat) v.rest = { categorieId: cat.id, bedrag: verschil, label: "Ingehouden Mollie-kosten (zonder factuur)" };
        }
      }
      if (koppelingen.length) uit.push(v);
    }
  }

  // 2. Facturen
  for (const p of posten) {
    const { score, redenen } = scoreMatch({ ...t, bedrag: rest }, p);
    if (score < 20) continue;
    uit.push({
      soort: "factuur",
      score,
      titel: `${p.soort === "verkoop" ? "Verkoop" : "Inkoop"} ${p.factuurnummer ?? `#${p.id}`} – ${p.relatie_naam ?? "?"}`,
      redenen,
      koppelingen: [{ soort: p.soort, factuurId: p.id, bedrag: Math.abs(rest) <= Math.abs(p.bankBedrag) ? rest : p.bankBedrag, label: `${p.factuurnummer ?? p.id}` }],
    });
  }

  // 3. Bankregels (boeken zonder factuur)
  const regels = ctx.db.all<{ id: number; naam: string; veld: string; bevat: string; categorie_id: number | null }>("SELECT * FROM bankregels WHERE actief = 1 AND categorie_id IS NOT NULL");
  for (const r of regels) {
    const veld = r.veld === "tegenpartij" ? t.tegenpartij_naam : r.veld === "iban" ? t.tegenpartij_iban : t.omschrijving;
    if (veld && veld.toLowerCase().includes(r.bevat.toLowerCase())) {
      uit.push({ soort: "regel", score: 40, titel: `Regel: ${r.naam}`, redenen: [`${r.veld} bevat "${r.bevat}"`], koppelingen: [], categorieId: r.categorie_id! });
    }
  }
  return uit.sort((a, b) => b.score - a.score).slice(0, 6);
}

// ---------- Koppelen / boeken ----------

function werkStatusBij(ctx: Ctx, txId: number): void {
  const t = ctx.db.get<{ bedrag: number; categorie_id: number | null }>("SELECT bedrag, categorie_id FROM banktransacties WHERE id = ?", [txId])!;
  const k = ctx.db.get<{ n: number; s: number | null }>("SELECT COUNT(*) AS n, SUM(bedrag) AS s FROM transactie_koppelingen WHERE transactie_id = ?", [txId])!;
  const rest = t.bedrag - (k.s ?? 0);
  let status: Transactie["status"] = "open";
  if (k.n === 0 && t.categorie_id) status = "geboekt_zonder_factuur";
  else if (k.n > 0 && (rest === 0 || t.categorie_id)) status = "gekoppeld";
  ctx.db.run("UPDATE banktransacties SET status = ? WHERE id = ?", [status, txId]);
}

export interface KoppelInvoer {
  soort: "inkoop" | "verkoop";
  factuurId: number;
  bedrag: number;
}

/**
 * Koppelt een transactie aan één of meer facturen. Bedragen hebben het teken van de bank (verkoop +, inkoop −).
 * `restCategorieId` boekt het eventuele restant op een categorie (bv. ingehouden Mollie-kosten).
 */
export function koppel(ctx: Ctx, txId: number, invoer: KoppelInvoer[], opties: { restCategorieId?: number | null; automatisch?: boolean; gebruiker: string }): void {
  const t = ctx.db.get<Transactie>("SELECT * FROM banktransacties WHERE id = ?", [txId]);
  if (!t) throw new GebruikersFout("Transactie niet gevonden", 404);
  const huidig = ctx.db.get<{ s: number | null }>("SELECT SUM(bedrag) AS s FROM transactie_koppelingen WHERE transactie_id = ?", [txId])!.s ?? 0;
  const nieuw = invoer.reduce((s, k) => s + k.bedrag, 0);
  const totaal = huidig + nieuw;
  // Met een restpost (bv. ingehouden kosten) mogen de facturen samen meer zijn dan de bijschrijving.
  const metRest = opties.restCategorieId !== undefined && opties.restCategorieId !== null;
  if (!metRest && Math.abs(totaal) > Math.abs(t.bedrag) && Math.sign(totaal) === Math.sign(t.bedrag)) {
    throw new GebruikersFout("De gekoppelde bedragen zijn samen hoger dan het transactiebedrag");
  }
  ctx.db.tx(() => {
    for (const k of invoer) {
      if (k.bedrag === 0) continue;
      const tabel = k.soort === "inkoop" ? "inkoopfacturen" : "verkoopfacturen";
      const f = ctx.db.get<{ status: string }>(`SELECT status FROM ${tabel} WHERE id = ?`, [k.factuurId]);
      if (!f) throw new GebruikersFout(`Factuur ${k.factuurId} niet gevonden`);
      if (f.status !== "geboekt") throw new GebruikersFout("Alleen geboekte facturen kunnen worden gekoppeld");
      ctx.db.run(`INSERT INTO transactie_koppelingen (transactie_id, ${k.soort === "inkoop" ? "inkoopfactuur_id" : "verkoopfactuur_id"}, bedrag, automatisch) VALUES (?, ?, ?, ?)`, [
        txId,
        k.factuurId,
        k.bedrag,
        opties.automatisch ? 1 : 0,
      ]);
    }
    if (opties.restCategorieId !== undefined) ctx.db.run("UPDATE banktransacties SET categorie_id = ? WHERE id = ?", [opties.restCategorieId, txId]);
    werkStatusBij(ctx, txId);
    audit(ctx.db, opties.gebruiker, opties.automatisch ? "automatisch_gekoppeld" : "gekoppeld", "banktransacties", txId, { koppelingen: invoer, restCategorieId: opties.restCategorieId });
  });
}

export function ontkoppel(ctx: Ctx, txId: number, gebruiker: string): void {
  ctx.db.tx(() => {
    ctx.db.run("DELETE FROM transactie_koppelingen WHERE transactie_id = ?", [txId]);
    ctx.db.run("UPDATE banktransacties SET categorie_id = NULL, status = 'open' WHERE id = ?", [txId]);
    audit(ctx.db, gebruiker, "ontkoppeld", "banktransacties", txId);
  });
}

export function boekZonderFactuur(ctx: Ctx, txId: number, categorieId: number, notitie: string | null, gebruiker: string): void {
  const t = ctx.db.get("SELECT id FROM banktransacties WHERE id = ?", [txId]);
  if (!t) throw new GebruikersFout("Transactie niet gevonden", 404);
  if (!ctx.db.get("SELECT id FROM categorieen WHERE id = ?", [categorieId])) throw new GebruikersFout("Onbekende categorie");
  ctx.db.tx(() => {
    ctx.db.run("UPDATE banktransacties SET categorie_id = ?, notitie = ? WHERE id = ?", [categorieId, notitie, txId]);
    werkStatusBij(ctx, txId);
    audit(ctx.db, gebruiker, "geboekt_zonder_factuur", "banktransacties", txId, { categorieId, notitie });
  });
}

/**
 * Automatisch afletteren: alleen bij één eenduidige, sterke match (factuurnummer + exact bedrag),
 * of een Mollie-uitbetaling die exact sluit. Alles daaronder blijft een voorstel.
 */
export function autoAfletteren(ctx: Ctx, gebruiker = "systeem"): number {
  let n = 0;
  const open = transacties(ctx, { status: "open", limiet: 5000 });
  for (const t of open) {
    const posten = openPosten(ctx);
    const vs = voorstellen(ctx, t, posten);
    const [eerste, tweede] = vs;
    if (!eerste || eerste.soort === "regel") continue;
    const sluit = eerste.koppelingen.reduce((s, k) => s + k.bedrag, 0) + (eerste.rest?.bedrag ?? 0) === t.bedrag - (t.gekoppeld_bedrag ?? 0);
    const sterk =
      (eerste.soort === "factuur" && eerste.redenen.includes("factuurnummer in omschrijving") && eerste.redenen.includes("bedrag exact gelijk")) ||
      (eerste.soort === "mollie" && sluit);
    if (sterk && sluit && (!tweede || tweede.score < 50)) {
      koppel(ctx, t.id, eerste.koppelingen, { restCategorieId: eerste.rest?.categorieId, automatisch: true, gebruiker });
      n++;
    }
  }
  return n;
}

/** Afschrijvingen zonder factuur (ouder dan `dagen`, boven `drempel`). */
export function ontbrekendeFacturen(ctx: Ctx, drempel = 0, dagen = 3): Transactie[] {
  const grens = new Date(Date.now() - dagen * 86400000).toISOString().slice(0, 10);
  return ctx.db.all<Transactie>(
    "SELECT * FROM banktransacties WHERE status = 'open' AND bedrag < ? AND boekdatum <= ? AND NOT EXISTS (SELECT 1 FROM transactie_koppelingen k WHERE k.transactie_id = banktransacties.id) ORDER BY boekdatum DESC LIMIT 200",
    [-drempel, grens],
  );
}

// ---------- Bankregels ----------

export function bankregels(ctx: Ctx) {
  return ctx.db.all<{ id: number; naam: string; veld: string; bevat: string; categorie_id: number | null; relatie_id: number | null; actief: number; categorie_naam: string | null }>(
    "SELECT b.*, c.naam AS categorie_naam FROM bankregels b LEFT JOIN categorieen c ON c.id = b.categorie_id ORDER BY b.naam",
  );
}

export function slaBankregelOp(ctx: Ctx, d: { naam: string; veld: string; bevat: string; categorie_id: number }, gebruiker: string): number {
  if (!d.naam.trim() || !d.bevat.trim()) throw new GebruikersFout("Naam en zoektekst zijn verplicht");
  if (!["tegenpartij", "omschrijving", "iban"].includes(d.veld)) throw new GebruikersFout("Ongeldig veld");
  const id = ctx.db.run("INSERT INTO bankregels (naam, veld, bevat, categorie_id) VALUES (?, ?, ?, ?)", [d.naam.trim(), d.veld, d.bevat.trim(), d.categorie_id]).id;
  audit(ctx.db, gebruiker, "aangemaakt", "bankregels", id, d);
  return id;
}

export function verwijderBankregel(ctx: Ctx, id: number, gebruiker: string): void {
  ctx.db.run("DELETE FROM bankregels WHERE id = ?", [id]);
  audit(ctx.db, gebruiker, "verwijderd", "bankregels", id);
}

/** Past bankregels toe op open transacties zonder factuurvoorstel. */
export function pasRegelsToe(ctx: Ctx, gebruiker: string): number {
  let n = 0;
  const posten = openPosten(ctx);
  for (const t of transacties(ctx, { status: "open", limiet: 5000 })) {
    if ((t.gekoppeld_bedrag ?? 0) !== 0) continue;
    const vs = voorstellen(ctx, t, posten);
    if (vs.some((v) => v.soort !== "regel" && v.score >= 50)) continue; // er is een factuur die beter past
    const regel = vs.find((v) => v.soort === "regel");
    if (regel?.categorieId) {
      boekZonderFactuur(ctx, t.id, regel.categorieId, regel.titel, gebruiker);
      n++;
    }
  }
  return n;
}
