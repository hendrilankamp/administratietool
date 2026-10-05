import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.ts";
import { Db } from "../db/index.ts";
import type { Logger } from "../lib/context.ts";
import { controletotalen, lijstBackups, ontsleutelBestand, verifieerZip, type Controletotalen, type Manifest } from "./maak.ts";
import { leesZip } from "./zip.ts";

const herstelDir = (config: Config) => path.join(config.dataDir, "herstel");
const markering = (config: Config) => path.join(herstelDir(config), "KLAAR.json");

/** Pakt een (geverifieerde) backup uit naar `doelDir`. Alleen bekende mappen/bestanden worden uitgepakt. */
async function pakUit(zipPad: string, doelDir: string): Promise<void> {
  await leesZip(zipPad, (naam) => {
    if (naam === "database.sqlite" || naam === "manifest.json" || /^(data|attachments)\/[\w.\-]+$/.test(naam)) {
      return path.join(doelDir, naam);
    }
    return null;
  });
}

/** Bouwt een database op uit alleen de JSON-bestanden (voor als de SQLite-snapshot onbruikbaar is). */
export async function bouwDbUitJson(jsonDir: string, doelPad: string): Promise<void> {
  fs.rmSync(doelPad, { force: true });
  const db = new Db(doelPad);
  try {
    await db.migreer();
    const tabellen = db.tabellen();
    db.raw.exec("PRAGMA foreign_keys = OFF");
    db.tx(() => {
      for (const t of tabellen) db.run(`DELETE FROM "${t}"`);
      for (const t of tabellen) {
        if (t === "gebruikers") continue; // wachtwoorden staan niet in de JSON; account opnieuw aanmaken
        const bestand = path.join(jsonDir, `${t}.json`);
        if (!fs.existsSync(bestand)) continue;
        const rijen = JSON.parse(fs.readFileSync(bestand, "utf8")) as Record<string, unknown>[];
        const kolommen = new Set((db.all<{ name: string }>(`PRAGMA table_info("${t}")`)).map((k) => k.name));
        for (const r of rijen) {
          const k = Object.keys(r).filter((c) => kolommen.has(c));
          db.run(
            `INSERT INTO "${t}" (${k.map((c) => `"${c}"`).join(", ")}) VALUES (${k.map(() => "?").join(", ")})`,
            k.map((c) => r[c] as string | number | null),
          );
        }
      }
    });
    db.raw.exec("PRAGMA foreign_keys = ON");
    const fk = db.all("PRAGMA foreign_key_check");
    if (fk.length > 0) throw new Error(`Herstel uit JSON: ${fk.length} ongeldige verwijzing(en)`);
  } finally {
    db.close();
  }
}

/** Controleert een herstelde database tegen het manifest. Geeft een lijst met afwijkingen (leeg = goed). */
export function vergelijkMetManifest(dbPad: string, manifest: Manifest, opties: { negeerTabellen?: string[] } = {}): string[] {
  const db = new DatabaseSync(dbPad, { readOnly: true });
  const fouten: string[] = [];
  try {
    const integriteit = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    if (integriteit !== "ok") fouten.push(`integrity_check: ${integriteit}`);
    for (const [t, verwacht] of Object.entries(manifest.tabellen)) {
      if (opties.negeerTabellen?.includes(t)) continue;
      const bestaat = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
      if (!bestaat) {
        fouten.push(`tabel ${t} ontbreekt`);
        continue;
      }
      const n = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n);
      if (n !== verwacht) fouten.push(`${t}: ${n} rijen, verwacht ${verwacht}`);
    }
    const tot = controletotalen(db);
    for (const k of Object.keys(manifest.controletotalen) as (keyof Controletotalen)[]) {
      if (tot[k] !== manifest.controletotalen[k]) fouten.push(`controletotaal ${k}: ${tot[k]}, verwacht ${manifest.controletotalen[k]}`);
    }
  } finally {
    db.close();
  }
  return fouten;
}

function maxMigratieVersie(): number {
  const dir = new URL("../db/migrations/", import.meta.url);
  return Math.max(0, ...fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).map((f) => Number.parseInt(f, 10)));
}

export interface HerstelOpties {
  passphrase?: string;
  identity?: string;
  forceerJson?: boolean;
}

/**
 * Stap 1 van herstel: backup verifiëren, uitpakken en een kant-en-klare database klaarzetten.
 * De daadwerkelijke wissel gebeurt bij de volgende start van de app (`voerHerstelUitBijStart`),
 * zodat er nooit een database wordt vervangen die in gebruik is.
 */
export async function bereidHerstelVoor(config: Config, bestand: string, opties: HerstelOpties = {}): Promise<{ manifest: Manifest; modus: "sqlite" | "json" }> {
  const dir = herstelDir(config);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let zipPad = bestand;
  if (bestand.endsWith(".age")) {
    zipPad = path.join(dir, "backup.zip");
    await ontsleutelBestand(bestand, zipPad, { passphrase: opties.passphrase ?? config.AGE_PASSPHRASE, identity: opties.identity });
  }
  const manifest = await verifieerZip(zipPad);
  const uit = path.join(dir, "uitgepakt");
  await pakUit(zipPad, uit);

  const nieuweDb = path.join(dir, "boekhouding.sqlite");
  let modus: "sqlite" | "json" = "sqlite";
  const snapshot = path.join(uit, "database.sqlite");
  if (!opties.forceerJson && fs.existsSync(snapshot) && manifest.schemaVersie <= maxMigratieVersie()) {
    fs.copyFileSync(snapshot, nieuweDb);
    const fouten = vergelijkMetManifest(nieuweDb, manifest);
    if (fouten.length) throw new Error(`Snapshot klopt niet met manifest:\n- ${fouten.join("\n- ")}`);
  } else {
    modus = "json";
    await bouwDbUitJson(path.join(uit, "data"), nieuweDb);
    const fouten = vergelijkMetManifest(nieuweDb, manifest, { negeerTabellen: ["gebruikers", "schema_migraties"] });
    if (fouten.length) throw new Error(`Herstel uit JSON klopt niet met manifest:\n- ${fouten.join("\n- ")}`);
  }
  fs.writeFileSync(markering(config), JSON.stringify({ bron: path.basename(bestand), modus, voorbereidOp: new Date().toISOString(), manifest: { aangemaaktOp: manifest.aangemaaktOp, tabellen: manifest.tabellen } }, null, 2));
  if (zipPad !== bestand) fs.rmSync(zipPad, { force: true });
  return { manifest, modus };
}

export function herstelKlaargezet(config: Config): { bron: string; modus: string; voorbereidOp: string } | null {
  try {
    return JSON.parse(fs.readFileSync(markering(config), "utf8"));
  } catch {
    return null;
  }
}

/** Stap 2 van herstel: bij opstarten (database nog niet geopend) de klaargezette database inwisselen. */
export function voerHerstelUitBijStart(config: Config, log: Logger): boolean {
  const info = herstelKlaargezet(config);
  if (!info) return false;
  const dir = herstelDir(config);
  const nieuweDb = path.join(dir, "boekhouding.sqlite");
  if (!fs.existsSync(nieuweDb)) {
    log.error("Herstelmarkering gevonden maar geen database; herstel overgeslagen");
    fs.rmSync(markering(config), { force: true });
    return false;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const vorigeDir = path.join(config.dataDir, "vorige-databases", ts);
  fs.mkdirSync(vorigeDir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = config.dbPad + suffix;
    if (fs.existsSync(p)) fs.renameSync(p, path.join(vorigeDir, path.basename(p)));
  }
  fs.renameSync(nieuweDb, config.dbPad);

  // Bijlagen zijn content-addressed: ontbrekende bestanden aanvullen, nooit iets overschrijven.
  const bijlagenBron = path.join(dir, "uitgepakt", "attachments");
  let aangevuld = 0;
  if (fs.existsSync(bijlagenBron)) {
    fs.mkdirSync(config.bijlagenDir, { recursive: true });
    for (const f of fs.readdirSync(bijlagenBron)) {
      const doel = path.join(config.bijlagenDir, f);
      if (!fs.existsSync(doel)) {
        fs.copyFileSync(path.join(bijlagenBron, f), doel);
        aangevuld++;
      }
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  log.warn(`HERSTEL UITGEVOERD vanuit ${info.bron} (${info.modus}); vorige database bewaard in ${vorigeDir}; ${aangevuld} bijlage(n) aangevuld.`);
  return true;
}

/** Wekelijkse test: nieuwste backup verifiëren en zowel via SQLite als via JSON herstellen in een tijdelijke map. */
export async function testHerstel(config: Config): Promise<string> {
  const laatste = lijstBackups(config.backupDir)[0];
  if (!laatste) throw new Error("Geen backup gevonden om te testen");
  fs.mkdirSync(path.join(config.dataDir, "tmp"), { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(config.dataDir, "tmp", "herstel-test-"));
  try {
    const manifest = await verifieerZip(laatste.pad);
    await pakUit(laatste.pad, tmp);
    const fouten = vergelijkMetManifest(path.join(tmp, "database.sqlite"), manifest);
    const jsonDb = path.join(tmp, "uit-json.sqlite");
    await bouwDbUitJson(path.join(tmp, "data"), jsonDb);
    fouten.push(...vergelijkMetManifest(jsonDb, manifest, { negeerTabellen: ["gebruikers", "schema_migraties"] }).map((f) => `JSON: ${f}`));
    if (fouten.length) throw new Error(`Testherstel ${laatste.naam} mislukt:\n- ${fouten.join("\n- ")}`);
    const totaal = Object.values(manifest.tabellen).reduce((a, b) => a + b, 0);
    return `${laatste.naam}: OK (${totaal} rijen, ${manifest.controletotalen.aantal_bijlagen} bijlagen; SQLite én JSON)`;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
