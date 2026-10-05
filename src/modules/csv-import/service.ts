import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { Ctx } from "../../lib/context.ts";
import { audit, GebruikersFout } from "../../lib/context.ts";
import { sha256, willekeurigToken } from "../../lib/crypto.ts";
import { parseDatum } from "../../lib/datum.ts";
import { parseBedrag } from "../../lib/geld.ts";
import { normaliseerBtwNummer, normaliseerIban, slaRelatieOp } from "../relaties/service.ts";
import { INGEBOUWDE_PROFIELEN, type Doel, type Profiel, type ProfielConfig, type Veld } from "./profielen.ts";

export const MAX_CSV = 10 * 1024 * 1024;

// ---------- Inlezen ----------

export function decodeer(data: Buffer): { tekst: string; encoding: "utf-8" | "windows-1252" } {
  let tekst: string;
  let encoding: "utf-8" | "windows-1252" = "utf-8";
  try {
    tekst = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    tekst = new TextDecoder("windows-1252").decode(data);
    encoding = "windows-1252";
  }
  return { tekst: tekst.replace(/^﻿/, ""), encoding };
}

/** Raadt het scheidingsteken op basis van de eerste regels (buiten aanhalingstekens). */
export function raadScheiding(tekst: string): "," | ";" | "\t" {
  const regels = tekst.split(/\r?\n/).filter((r) => r.trim()).slice(0, 5);
  const telling = { ",": 0, ";": 0, "\t": 0 } as Record<"," | ";" | "\t", number>;
  for (const r of regels) {
    let inQuote = false;
    for (const ch of r) {
      if (ch === '"') inQuote = !inQuote;
      else if (!inQuote && ch in telling) telling[ch as "," | ";" | "\t"]++;
    }
  }
  return (Object.entries(telling).sort((a, b) => b[1] - a[1])[0][0] as "," | ";" | "\t") ?? ",";
}

export function leesCsv(data: Buffer, scheiding?: "," | ";" | "\t") {
  if (data.length > MAX_CSV) throw new GebruikersFout("CSV-bestand is groter dan 10 MB");
  if (data.subarray(0, 4096).includes(0)) throw new GebruikersFout("Dit lijkt geen tekst/CSV-bestand te zijn");
  const { tekst, encoding } = decodeer(data);
  const sep = scheiding ?? raadScheiding(tekst);
  let rijen: string[][];
  try {
    rijen = parse(tekst, { delimiter: sep, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, trim: true, bom: true }) as string[][];
  } catch (e) {
    throw new GebruikersFout(`CSV kon niet worden gelezen: ${(e as Error).message}`);
  }
  return { rijen, encoding, scheiding: sep };
}

/** Vindt de kopregel: de eerste regel (binnen de eerste 20) die alle herkenningskoppen bevat. */
function vindKopregel(rijen: string[][], herkenning: string[]): number {
  for (let i = 0; i < Math.min(rijen.length, 20); i++) {
    const set = new Set(rijen[i].map((c) => c.trim()));
    if (herkenning.every((h) => set.has(h))) return i;
  }
  return -1;
}

export function alleProfielen(ctx: Ctx, doel?: Doel): Profiel[] {
  const eigen = ctx.db
    .all<{ id: number; naam: string; config: string }>("SELECT id, naam, config FROM csv_profielen ORDER BY naam")
    .map((r) => ({ id: r.id, naam: r.naam, config: JSON.parse(r.config) as ProfielConfig, ingebouwd: false }));
  return [...INGEBOUWDE_PROFIELEN, ...eigen].filter((p) => !doel || p.config.doel === doel);
}

export function detecteerProfiel(ctx: Ctx, rijen: string[][], doel?: Doel): { profiel: Profiel; kopIndex: number } | null {
  // Eigen profielen eerst (specifieker), dan ingebouwd
  const profielen = alleProfielen(ctx, doel).sort((a, b) => Number(a.ingebouwd) - Number(b.ingebouwd));
  for (const p of profielen) {
    const i = vindKopregel(rijen, p.config.herkenning);
    if (i >= 0) return { profiel: p, kopIndex: i };
  }
  return null;
}

// ---------- Omzetten naar records ----------

export interface BankRecord {
  regel: number;
  boekdatum: string;
  valutadatum: string | null;
  bedrag: number;
  valuta: string;
  tegenpartij_naam: string | null;
  tegenpartij_iban: string | null;
  omschrijving: string | null;
  type: string | null;
}

export interface Fout {
  regel: number;
  melding: string;
  ruw: string[];
}

function waarde(rij: string[], kop: string[], kolommen: string[] | undefined): string | null {
  if (!kolommen?.length) return null;
  const delen = kolommen.map((k) => rij[kop.indexOf(k)]?.trim() ?? "").filter((v) => v !== "");
  return delen.length ? delen.join(" ").replace(/\s+/g, " ") : null;
}

export function naarBankRecords(rijen: string[][], kopIndex: number, cfg: ProfielConfig): { records: BankRecord[]; fouten: Fout[] } {
  const kop = rijen[kopIndex].map((c) => c.trim());
  const ontbrekend = Object.values(cfg.kolommen).flat().filter((k) => !kop.includes(k!));
  if (ontbrekend.length) throw new GebruikersFout(`Kolommen niet gevonden in het bestand: ${ontbrekend.join(", ")}`);
  const records: BankRecord[] = [];
  const fouten: Fout[] = [];
  for (let i = kopIndex + 1; i < rijen.length; i++) {
    const rij = rijen[i];
    if (rij.every((c) => !c.trim())) continue;
    const regel = i + 1;
    const k = cfg.kolommen;
    const boekdatum = parseDatum(waarde(rij, kop, k.boekdatum), cfg.datumFormaat);
    let bedrag: number | null = null;
    if (cfg.bedragModus === "een_kolom") bedrag = parseBedrag(waarde(rij, kop, k.bedrag), cfg.decimaal);
    else if (cfg.bedragModus === "bij_af") {
      const bij = parseBedrag(waarde(rij, kop, k.bij), cfg.decimaal) ?? 0;
      const af = parseBedrag(waarde(rij, kop, k.af), cfg.decimaal) ?? 0;
      bedrag = Math.abs(bij) - Math.abs(af);
    } else {
      const b = parseBedrag(waarde(rij, kop, k.bedrag), cfg.decimaal);
      const ind = waarde(rij, kop, k.af_bij);
      if (b !== null) bedrag = ind?.toLowerCase() === (cfg.afWaarde ?? "af").toLowerCase() ? -Math.abs(b) : Math.abs(b);
    }
    if (!boekdatum) {
      fouten.push({ regel, melding: "Ongeldige of ontbrekende datum", ruw: rij });
      continue;
    }
    if (bedrag === null) {
      fouten.push({ regel, melding: "Ongeldig of ontbrekend bedrag", ruw: rij });
      continue;
    }
    const iban = waarde(rij, kop, k.tegenpartij_iban);
    records.push({
      regel,
      boekdatum,
      valutadatum: parseDatum(waarde(rij, kop, k.valutadatum), cfg.datumFormaat),
      bedrag,
      valuta: (waarde(rij, kop, k.valuta) ?? "EUR").toUpperCase().slice(0, 3),
      tegenpartij_naam: waarde(rij, kop, k.tegenpartij_naam)?.slice(0, 200) ?? null,
      tegenpartij_iban: iban ? normaliseerIban(iban).slice(0, 34) : null,
      omschrijving: waarde(rij, kop, k.omschrijving)?.slice(0, 1000) ?? null,
      type: waarde(rij, kop, k.type)?.slice(0, 100) ?? null,
    });
  }
  return { records, fouten };
}

/**
 * Vingerafdruk voor ontdubbeling. N26 levert geen transactie-ID, dus: rekening + datum + bedrag + tegenpartij + omschrijving
 * + volgnummer binnen identieke regels in hetzelfde bestand. Zo leveren overlappende exports geen dubbelen op.
 */
export function vingerafdrukken(rekeningId: number, records: BankRecord[]): string[] {
  const teller = new Map<string, number>();
  return records.map((r) => {
    const basis = [rekeningId, r.boekdatum, r.bedrag, r.tegenpartij_iban ?? "", (r.tegenpartij_naam ?? "").toLowerCase(), (r.omschrijving ?? "").toLowerCase().replace(/\s+/g, " ")].join("|");
    const n = teller.get(basis) ?? 0;
    teller.set(basis, n + 1);
    return sha256(`${basis}|${n}`);
  });
}

// ---------- Tijdelijke opslag tussen preview en import ----------

function tmpDir(ctx: Ctx) {
  return path.join(ctx.config.dataDir, "tmp");
}

export function bewaarUpload(ctx: Ctx, data: Buffer): string {
  const token = willekeurigToken(18);
  fs.mkdirSync(tmpDir(ctx), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(tmpDir(ctx), `import-${token}.csv`), data, { mode: 0o600 });
  // Opruimen van oude uploads (> 2 uur)
  for (const f of fs.readdirSync(tmpDir(ctx))) {
    const p = path.join(tmpDir(ctx), f);
    if (Date.now() - fs.statSync(p).mtimeMs > 2 * 3600_000) fs.rmSync(p, { force: true });
  }
  return token;
}

export function leesUpload(ctx: Ctx, token: string): Buffer {
  if (!/^[\w-]{20,40}$/.test(token)) throw new GebruikersFout("Ongeldige upload");
  const p = path.join(tmpDir(ctx), `import-${token}.csv`);
  if (!fs.existsSync(p)) throw new GebruikersFout("Upload verlopen; upload het bestand opnieuw");
  return fs.readFileSync(p);
}

export function verwijderUpload(ctx: Ctx, token: string): void {
  if (/^[\w-]{20,40}$/.test(token)) fs.rmSync(path.join(tmpDir(ctx), `import-${token}.csv`), { force: true });
}

// ---------- Analyse (preview) en import ----------

export interface Analyse {
  encoding: string;
  scheiding: string;
  kop: string[];
  kopIndex: number;
  profiel: Profiel | null;
  bank?: { records: (BankRecord & { dubbel: boolean; fingerprint: string })[]; fouten: Fout[] };
  relaties?: { records: { regel: number; data: Record<string, string | null>; bestaand: boolean }[]; fouten: Fout[] };
}

export function analyseer(ctx: Ctx, data: Buffer, opties: { doel: Doel; profiel?: Profiel | null; rekeningId?: number }): Analyse {
  const { rijen, encoding, scheiding } = leesCsv(data, opties.profiel?.config.scheiding);
  if (rijen.length === 0) throw new GebruikersFout("Het bestand is leeg");
  let profiel = opties.profiel ?? null;
  let kopIndex = 0;
  if (profiel) {
    kopIndex = vindKopregel(rijen, profiel.config.herkenning.length ? profiel.config.herkenning : Object.values(profiel.config.kolommen).flat() as string[]);
    if (kopIndex < 0) kopIndex = 0;
  } else {
    const d = detecteerProfiel(ctx, rijen, opties.doel);
    if (d) ({ profiel, kopIndex } = d);
  }
  const res: Analyse = { encoding, scheiding, kop: rijen[kopIndex].map((c) => c.trim()), kopIndex, profiel };
  if (!profiel) return res;

  if (opties.doel === "banktransacties") {
    const { records, fouten } = naarBankRecords(rijen, kopIndex, profiel.config);
    const vingers = opties.rekeningId ? vingerafdrukken(opties.rekeningId, records) : records.map(() => "");
    const bestaand = new Set<string>();
    if (opties.rekeningId) {
      for (const v of vingers) if (ctx.db.get("SELECT 1 FROM banktransacties WHERE fingerprint = ?", [v])) bestaand.add(v);
    }
    res.bank = { records: records.map((r, i) => ({ ...r, fingerprint: vingers[i], dubbel: bestaand.has(vingers[i]) })), fouten };
  } else {
    const kop = res.kop;
    const fouten: Fout[] = [];
    const recs: { regel: number; data: Record<string, string | null>; bestaand: boolean }[] = [];
    for (let i = kopIndex + 1; i < rijen.length; i++) {
      const rij = rijen[i];
      if (rij.every((c) => !c.trim())) continue;
      const d: Record<string, string | null> = {};
      for (const [veld, kolommen] of Object.entries(profiel.config.kolommen)) d[veld] = waarde(rij, kop, kolommen);
      if (!d.naam) {
        fouten.push({ regel: i + 1, melding: "Naam ontbreekt", ruw: rij });
        continue;
      }
      const bestaand = !!ctx.db.get(
        "SELECT 1 FROM relaties WHERE lower(naam) = lower(?) OR (iban IS NOT NULL AND iban = ?) OR (btw_nummer IS NOT NULL AND btw_nummer = ?)",
        [d.naam, d.iban ? normaliseerIban(d.iban) : null, d.btw_nummer ? normaliseerBtwNummer(d.btw_nummer) : null],
      );
      recs.push({ regel: i + 1, data: d, bestaand });
    }
    res.relaties = { records: recs, fouten };
  }
  return res;
}

export interface ImportResultaat {
  batchId: number;
  nieuw: number;
  dubbel: number;
  fout: number;
}

/** Importeert alles in één transactie (alles of niets). */
export function importeer(
  ctx: Ctx,
  data: Buffer,
  opties: { doel: Doel; profiel: Profiel; rekeningId?: number; bestandsnaam: string; gebruiker: string },
): ImportResultaat {
  const a = analyseer(ctx, data, opties);
  const hash = sha256(data);
  return ctx.db.tx(() => {
    if (opties.doel === "banktransacties") {
      if (!opties.rekeningId) throw new GebruikersFout("Kies een bankrekening");
      const recs = a.bank!.records;
      const nieuw = recs.filter((r) => !r.dubbel);
      const batchId = ctx.db.run(
        "INSERT INTO import_batches (doel, profiel_naam, bestandsnaam, sha256, rekening_id, aantal_nieuw, aantal_dubbel, aantal_fout) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [opties.doel, opties.profiel.naam, opties.bestandsnaam.slice(0, 200), hash, opties.rekeningId, nieuw.length, recs.length - nieuw.length, a.bank!.fouten.length],
      ).id;
      for (const r of nieuw) {
        ctx.db.run(
          `INSERT INTO banktransacties (rekening_id, boekdatum, valutadatum, bedrag, valuta, tegenpartij_naam, tegenpartij_iban, omschrijving, type, import_batch_id, fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [opties.rekeningId, r.boekdatum, r.valutadatum, r.bedrag, r.valuta, r.tegenpartij_naam, r.tegenpartij_iban, r.omschrijving, r.type, batchId, r.fingerprint],
        );
      }
      audit(ctx.db, opties.gebruiker, "csv_import", "import_batches", batchId, { profiel: opties.profiel.naam, nieuw: nieuw.length });
      return { batchId, nieuw: nieuw.length, dubbel: recs.length - nieuw.length, fout: a.bank!.fouten.length };
    }
    const recs = a.relaties!.records;
    const nieuw = recs.filter((r) => !r.bestaand);
    const batchId = ctx.db.run(
      "INSERT INTO import_batches (doel, profiel_naam, bestandsnaam, sha256, aantal_nieuw, aantal_dubbel, aantal_fout) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [opties.doel, opties.profiel.naam, opties.bestandsnaam.slice(0, 200), hash, nieuw.length, recs.length - nieuw.length, a.relaties!.fouten.length],
    ).id;
    for (const r of nieuw) {
      const t = (r.data.type ?? "").toLowerCase();
      const type = t.startsWith("lev") || t.startsWith("sup") ? "leverancier" : t.startsWith("beide") || t.startsWith("both") ? "beide" : "klant";
      try {
        slaRelatieOp(ctx, null, { ...r.data, naam: r.data.naam!, type }, opties.gebruiker);
      } catch (e) {
        if (e instanceof z.ZodError) throw new GebruikersFout(`Regel ${r.regel}: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`);
        throw e;
      }
    }
    audit(ctx.db, opties.gebruiker, "csv_import", "import_batches", batchId, { profiel: opties.profiel.naam, nieuw: nieuw.length });
    return { batchId, nieuw: nieuw.length, dubbel: recs.length - nieuw.length, fout: a.relaties!.fouten.length };
  });
}

/** Draait een bankimport terug, alleen als er nog niets mee is gedaan. */
export function draaiImportTerug(ctx: Ctx, batchId: number, gebruiker: string): number {
  const b = ctx.db.get<{ id: number; doel: string; teruggedraaid_op: string | null }>("SELECT id, doel, teruggedraaid_op FROM import_batches WHERE id = ?", [batchId]);
  if (!b) throw new GebruikersFout("Import niet gevonden", 404);
  if (b.teruggedraaid_op) throw new GebruikersFout("Deze import is al teruggedraaid");
  if (b.doel !== "banktransacties") throw new GebruikersFout("Alleen bankimports kunnen worden teruggedraaid");
  const inGebruik = ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM banktransacties t WHERE t.import_batch_id = ? AND (t.status <> 'open' OR EXISTS (SELECT 1 FROM transactie_koppelingen k WHERE k.transactie_id = t.id))`,
    [batchId],
  )!.n;
  if (inGebruik > 0) throw new GebruikersFout(`${inGebruik} transactie(s) uit deze import zijn al afgeletterd; ontkoppel die eerst.`);
  return ctx.db.tx(() => {
    const n = ctx.db.run("DELETE FROM banktransacties WHERE import_batch_id = ?", [batchId]).changes;
    ctx.db.run("UPDATE import_batches SET teruggedraaid_op = ? WHERE id = ?", [new Date().toISOString(), batchId]);
    audit(ctx.db, gebruiker, "csv_import_teruggedraaid", "import_batches", batchId, { verwijderd: n });
    return n;
  });
}

export function slaProfielOp(ctx: Ctx, naam: string, config: ProfielConfig, gebruiker: string): number {
  if (INGEBOUWDE_PROFIELEN.some((p) => p.naam === naam)) throw new GebruikersFout("Deze naam is gereserveerd voor een ingebouwd profiel");
  const r = ctx.db.run(
    "INSERT INTO csv_profielen (naam, doel, config) VALUES (?, ?, ?) ON CONFLICT(naam) DO UPDATE SET doel = excluded.doel, config = excluded.config",
    [naam.slice(0, 100), config.doel, JSON.stringify(config)],
  );
  audit(ctx.db, gebruiker, "csv_profiel_opgeslagen", "csv_profielen", naam);
  return r.id;
}

export function vindProfiel(ctx: Ctx, naam: string): Profiel | undefined {
  return alleProfielen(ctx).find((p) => p.naam === naam);
}

export type { Veld };
