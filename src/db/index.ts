import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Params = Record<string, SQLInputValue | boolean | undefined> | Array<SQLInputValue | boolean | undefined>;
export type Rij = Record<string, unknown>;

const migratieDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/** Dunne wrapper rond node:sqlite met prepared statements, transacties en migraties. */
export class Db {
  readonly raw: DatabaseSync;
  readonly pad: string;
  private inTx = 0;

  constructor(pad: string) {
    this.pad = pad;
    if (pad !== ":memory:") fs.mkdirSync(path.dirname(pad), { recursive: true });
    this.raw = new DatabaseSync(pad);
    this.raw.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (pad !== ":memory:") this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  }

  all<T = Rij>(sql: string, params: Params = []): T[] {
    return this.raw.prepare(sql).all(...(normaliseer(params) as SQLInputValue[])) as T[];
  }

  get<T = Rij>(sql: string, params: Params = []): T | undefined {
    return this.raw.prepare(sql).get(...(normaliseer(params) as SQLInputValue[])) as T | undefined;
  }

  run(sql: string, params: Params = []): { changes: number; id: number } {
    const r = this.raw.prepare(sql).run(...(normaliseer(params) as SQLInputValue[]));
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  }

  /** Voert fn uit in één transactie (genest = savepoint). Bij een fout wordt alles teruggedraaid. */
  tx<T>(fn: () => T): T {
    const sp = `sp${this.inTx}`;
    this.raw.exec(this.inTx === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
    this.inTx++;
    try {
      const res = fn();
      this.inTx--;
      this.raw.exec(this.inTx === 0 ? "COMMIT" : `RELEASE ${sp}`);
      return res;
    } catch (e) {
      this.inTx--;
      this.raw.exec(this.inTx === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }

  tabellen(): string[] {
    return this.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migraties' ORDER BY name",
    ).map((r) => r.name);
  }

  schemaVersie(): number {
    this.raw.exec("CREATE TABLE IF NOT EXISTS schema_migraties (versie INTEGER PRIMARY KEY, toegepast_op TEXT NOT NULL)");
    return this.get<{ v: number | null }>("SELECT MAX(versie) AS v FROM schema_migraties")?.v ?? 0;
  }

  openstaandeMigraties(): { versie: number; bestand: string }[] {
    const huidig = this.schemaVersie();
    return fs
      .readdirSync(migratieDir)
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .map((f) => ({ versie: Number.parseInt(f, 10), bestand: f }))
      .filter((m) => m.versie > huidig)
      .sort((a, b) => a.versie - b.versie);
  }

  /** Past openstaande migraties toe. `voorMigratie` wordt aangeroepen als er al data is (bv. om eerst een backup te maken). */
  async migreer(voorMigratie?: () => Promise<void>): Promise<number[]> {
    const open = this.openstaandeMigraties();
    if (open.length === 0) return [];
    if (this.schemaVersie() > 0 && voorMigratie) await voorMigratie();
    for (const m of open) {
      const sql = fs.readFileSync(path.join(migratieDir, m.bestand), "utf8");
      this.tx(() => {
        this.raw.exec(sql);
        this.run("INSERT INTO schema_migraties (versie, toegepast_op) VALUES (?, ?)", [m.versie, new Date().toISOString()]);
      });
    }
    return open.map((m) => m.versie);
  }

  close(): void {
    this.raw.close();
  }
}

/** Zet booleans/undefined om; een object (named parameters) wordt als enig argument doorgegeven. */
function normaliseer(params: Params): unknown[] {
  const conv = (v: SQLInputValue | boolean | undefined): SQLInputValue =>
    v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v;
  if (Array.isArray(params)) return params.map(conv);
  const o: Record<string, SQLInputValue> = {};
  for (const [k, v] of Object.entries(params)) o[k] = conv(v);
  return [o];
}
