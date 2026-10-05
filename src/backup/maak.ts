import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Encrypter } from "age-encryption";
import type { Ctx } from "../lib/context.ts";
import { sha256 } from "../lib/crypto.ts";
import { naarCsv } from "../lib/csv.ts";
import { bijlageBestandsnaamOpSchijf } from "../lib/bijlagen.ts";
import { leesZip, ZipSchrijver } from "./zip.ts";
import { roteer } from "./rotatie.ts";

export const BACKUP_FORMAAT = "medialan-boekhouding-backup";
export const BACKUP_FORMAAT_VERSIE = 1;
/** Tabellen met geheimen/vluchtige data die niet in de JSON/CSV-export horen. */
export const UITGESLOTEN_TABELLEN = new Set(["sessies", "inlogpogingen"]);
/** Kolommen die nooit in JSON/CSV terechtkomen. */
export const GEHEIME_KOLOMMEN: Record<string, string[]> = { gebruikers: ["wachtwoord_hash", "totp_geheim"] };

export interface Manifest {
  formaat: typeof BACKUP_FORMAAT;
  formaatVersie: number;
  schemaVersie: number;
  appVersie: string;
  aangemaaktOp: string;
  reden: string;
  tabellen: Record<string, number>;
  controletotalen: Controletotalen;
  bestanden: Record<string, { sha256: string; grootte: number }>;
  toelichting: string;
}

export interface Controletotalen {
  inkoop_totaal_incl: number;
  verkoop_totaal_incl: number;
  bank_som_bedrag: number;
  aantal_bijlagen: number;
}

export function controletotalen(db: DatabaseSync): Controletotalen {
  const n = (sql: string) => Number((db.prepare(sql).get() as { v: number | null }).v ?? 0);
  return {
    inkoop_totaal_incl: n("SELECT SUM(totaal_incl) AS v FROM inkoopfacturen"),
    verkoop_totaal_incl: n("SELECT SUM(totaal_incl) AS v FROM verkoopfacturen"),
    bank_som_bedrag: n("SELECT SUM(bedrag) AS v FROM banktransacties"),
    aantal_bijlagen: n("SELECT COUNT(*) AS v FROM bijlagen"),
  };
}

function appVersie(): string {
  try {
    return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "onbekend";
  }
}

function tijdstempel(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

type Kolom = { name: string; type: string; notnull: number; pk: number };

function jsonSchemaVoorTabel(tabel: string, kolommen: Kolom[]): object {
  const typeVan = (t: string) => (/INT/i.test(t) ? "integer" : /REAL|FLOA|DOUB/i.test(t) ? "number" : "string");
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${tabel}.schema.json`,
    title: tabel,
    description: `Rijen uit tabel '${tabel}'. Bedragen zijn gehele centen; datums 'YYYY-MM-DD'; tijdstippen ISO-8601 (UTC).`,
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: kolommen.map((k) => k.name),
      properties: Object.fromEntries(
        kolommen.map((k) => [k.name, { type: k.notnull || k.pk ? typeVan(k.type) : [typeVan(k.type), "null"] }]),
      ),
    },
  };
}

const TOELICHTING = `Backup van Boekhouding Medialan.
- manifest.json: metadata, aantallen per tabel, controletotalen en sha256 van elk bestand.
- data/<tabel>.json: alle rijen per tabel (JSON-array). Bedragen zijn gehele centen (12345 = EUR 123,45).
- csv/<tabel>.csv: dezelfde data als CSV (UTF-8, scheidingsteken ';') voor Excel of de accountant.
- schema/<tabel>.schema.json: JSON Schema per tabel.
- attachments/<sha256>.<ext>: originele facturen; de bestandsnaam is de sha256 van de inhoud.
- database.sqlite: consistente SQLite-snapshot voor volledig herstel.
Wachtwoord-hashes en 2FA-geheimen staan niet in de JSON/CSV-bestanden.`;

export interface BackupResultaat {
  bestand: string;
  extern: string | null;
  /** Reden waarom de externe kopie niet is gemaakt (de lokale backup is dan wel geldig). */
  externFout: string | null;
  manifest: Manifest;
}

/** Maakt een volledige backup (zip) en optioneel een age-versleutelde externe kopie. */
export async function maakBackup(ctx: Ctx, reden: string): Promise<BackupResultaat> {
  const { config } = ctx;
  fs.mkdirSync(config.backupDir, { recursive: true });
  const naam = `medialan-backup-${tijdstempel()}`;
  const snapshotPad = path.join(config.backupDir, `.${naam}.sqlite.tmp`);
  const zipTmp = path.join(config.backupDir, `.${naam}.zip.tmp`);
  const zipPad = path.join(config.backupDir, `${naam}.zip`);

  try {
    // 1. Consistente snapshot van de database
    ctx.db.raw.prepare("VACUUM INTO ?").run(snapshotPad);
    const snap = new DatabaseSync(snapshotPad, { readOnly: true });
    const bestanden: Manifest["bestanden"] = {};
    const tabellenAantal: Record<string, number> = {};
    const zip = new ZipSchrijver(zipTmp);
    const voeg = (naam: string, data: Uint8Array | string, comprimeer = true) => {
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      bestanden[naam] = { sha256: sha256(bytes), grootte: bytes.length };
      zip.voegToe(naam, bytes, comprimeer);
    };

    let schemaVersie = 0;
    let totalen: Controletotalen;
    try {
      schemaVersie = Number((snap.prepare("SELECT MAX(versie) AS v FROM schema_migraties").get() as { v: number }).v ?? 0);
      const tabellen = (snap.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
        .map((r) => r.name)
        .filter((t) => !UITGESLOTEN_TABELLEN.has(t));

      // 2. JSON + CSV + schema per tabel
      for (const t of tabellen) {
        const kolommen = (snap.prepare(`PRAGMA table_info("${t}")`).all() as Kolom[]).filter((k) => !GEHEIME_KOLOMMEN[t]?.includes(k.name));
        const namen = kolommen.map((k) => k.name);
        const rijen = snap.prepare(`SELECT ${namen.map((n) => `"${n}"`).join(", ")} FROM "${t}" ORDER BY rowid`).all() as Record<string, unknown>[];
        tabellenAantal[t] = rijen.length;
        voeg(`data/${t}.json`, JSON.stringify(rijen.map((r) => ({ ...r })), null, 1));
        voeg(`csv/${t}.csv`, naarCsv(namen, rijen));
        voeg(`schema/${t}.schema.json`, JSON.stringify(jsonSchemaVoorTabel(t, kolommen), null, 2));
      }

      // 3. Originele bijlagen
      const bijlagen = snap.prepare("SELECT sha256, mime FROM bijlagen ORDER BY sha256").all() as { sha256: string; mime: string }[];
      for (const b of bijlagen) {
        const bestandsnaam = bijlageBestandsnaamOpSchijf(b.sha256, b.mime);
        const bron = path.join(config.bijlagenDir, bestandsnaam);
        if (!fs.existsSync(bron)) {
          ctx.log.warn(`Bijlage ontbreekt op schijf: ${bestandsnaam}`);
          continue;
        }
        voeg(`attachments/${bestandsnaam}`, fs.readFileSync(bron), false);
      }
      totalen = controletotalen(snap);
    } finally {
      snap.close();
    }

    // 4. SQLite-snapshot
    voeg("database.sqlite", fs.readFileSync(snapshotPad));
    voeg("LEESMIJ.txt", TOELICHTING);

    // 5. Manifest (als laatste, met checksums van alle andere bestanden)
    const manifest: Manifest = {
      formaat: BACKUP_FORMAAT,
      formaatVersie: BACKUP_FORMAAT_VERSIE,
      schemaVersie,
      appVersie: appVersie(),
      aangemaaktOp: new Date().toISOString(),
      reden,
      tabellen: tabellenAantal,
      controletotalen: totalen,
      bestanden,
      toelichting: TOELICHTING,
    };
    zip.voegToe("manifest.json", JSON.stringify(manifest, null, 2));
    await zip.sluit();

    // 6. Direct verifiëren voordat de backup "geldig" wordt
    await verifieerZip(zipTmp);
    fs.renameSync(zipTmp, zipPad);

    // 7. Versleutelde externe kopie. Mislukt die, dan blijft de lokale backup geldig maar faalt de taak zichtbaar.
    let extern: string | null = null;
    let externFout: string | null = null;
    if (config.BACKUP_EXTERN_DIR) {
      if (!config.AGE_PASSPHRASE && !config.AGE_RECIPIENT) {
        externFout = "geen versleutelingssleutel ingesteld (Instellingen → Backups)";
      } else {
        try {
          fs.mkdirSync(config.BACKUP_EXTERN_DIR, { recursive: true });
          const doel = path.join(config.BACKUP_EXTERN_DIR, `${naam}.zip.age`);
          await versleutelBestand(zipPad, doel, { passphrase: config.AGE_PASSPHRASE, recipient: config.AGE_RECIPIENT });
          extern = doel;
          roteer(config.BACKUP_EXTERN_DIR, ".zip.age", ctx.log);
        } catch (e) {
          externFout = (e as NodeJS.ErrnoException).code === "EROFS" || (e as NodeJS.ErrnoException).code === "EACCES"
            ? `map ${config.BACKUP_EXTERN_DIR} is niet beschrijfbaar (is de backupmap gekoppeld in docker-compose?)`
            : (e as Error).message;
        }
      }
    }

    roteer(config.backupDir, ".zip", ctx.log);
    ctx.log.info(`Backup gemaakt: ${path.basename(zipPad)}${extern ? " (+ versleutelde externe kopie)" : ""}`);
    if (externFout) ctx.log.warn(`Externe backupkopie mislukt: ${externFout}`);
    return { bestand: zipPad, extern, externFout, manifest };
  } finally {
    for (const p of [snapshotPad, zipTmp]) fs.rmSync(p, { force: true });
  }
}

/** Controleert of alle bestanden in de zip overeenkomen met het manifest. Geeft het manifest terug. */
export async function verifieerZip(pad: string): Promise<Manifest> {
  const { items, inhoud } = await leesZip(pad, (n) => (n === "manifest.json" ? "geheugen" : null));
  const mBuf = inhoud.get("manifest.json");
  if (!mBuf) throw new Error("manifest.json ontbreekt in backup");
  const manifest = JSON.parse(mBuf.toString("utf8")) as Manifest;
  if (manifest.formaat !== BACKUP_FORMAAT) throw new Error("Geen geldig backupformaat");
  const gevonden = new Map(items.map((i) => [i.naam, i]));
  for (const [naam, verwacht] of Object.entries(manifest.bestanden)) {
    const item = gevonden.get(naam);
    if (!item) throw new Error(`Bestand ontbreekt in backup: ${naam}`);
    if (item.sha256 !== verwacht.sha256 || item.grootte !== verwacht.grootte) throw new Error(`Checksum klopt niet: ${naam}`);
  }
  return manifest;
}

export async function versleutelBestand(bron: string, doel: string, sleutel: { passphrase?: string; recipient?: string }): Promise<void> {
  const e = new Encrypter();
  if (sleutel.recipient) e.addRecipient(sleutel.recipient);
  else if (sleutel.passphrase) e.setPassphrase(sleutel.passphrase);
  else throw new Error("Geen age-sleutel opgegeven");
  const tmp = `${doel}.tmp`;
  const invoer = Readable.toWeb(fs.createReadStream(bron)) as unknown as ReadableStream<Uint8Array>;
  const uitvoer = await e.encrypt(invoer);
  await pipeline(Readable.fromWeb(uitvoer as unknown as import("node:stream/web").ReadableStream), fs.createWriteStream(tmp, { mode: 0o640 }));
  fs.renameSync(tmp, doel);
}

export async function ontsleutelBestand(bron: string, doel: string, sleutel: { passphrase?: string; identity?: string }): Promise<void> {
  const { Decrypter } = await import("age-encryption");
  const d = new Decrypter();
  if (sleutel.identity) d.addIdentity(sleutel.identity);
  else if (sleutel.passphrase) d.addPassphrase(sleutel.passphrase);
  else throw new Error("Geen age-sleutel opgegeven voor ontsleutelen");
  const invoer = Readable.toWeb(fs.createReadStream(bron)) as unknown as ReadableStream<Uint8Array>;
  const uitvoer = await d.decrypt(invoer);
  await pipeline(Readable.fromWeb(uitvoer as unknown as import("node:stream/web").ReadableStream), fs.createWriteStream(doel, { mode: 0o600 }));
}

export function lijstBackups(dir: string, ext = ".zip"): { naam: string; pad: string; grootte: number; datum: Date }[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("medialan-backup-") && f.endsWith(ext))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { naam: f, pad: path.join(dir, f), grootte: st.size, datum: datumUitNaam(f) ?? st.mtime };
    })
    .sort((a, b) => b.datum.getTime() - a.datum.getTime());
}

export function datumUitNaam(naam: string): Date | null {
  const m = /medialan-backup-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(naam);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

