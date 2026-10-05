import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";

/** Gedeelde afhankelijkheden die aan modules worden doorgegeven. */
export interface Ctx {
  config: Config;
  db: Db;
  log: Logger;
}

export interface Logger {
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (m, e) => console.log(`${new Date().toISOString()} INFO  ${m}`, e ?? ""),
  warn: (m, e) => console.warn(`${new Date().toISOString()} WARN  ${m}`, e ?? ""),
  error: (m, e) => console.error(`${new Date().toISOString()} ERROR ${m}`, e ?? ""),
};

export const stilLogger: Logger = { info() {}, warn() {}, error() {} };

/** Fout die veilig aan de gebruiker getoond kan worden. */
export class GebruikersFout extends Error {
  readonly status: number;
  constructor(bericht: string, status = 400) {
    super(bericht);
    this.status = status;
  }
}

export function audit(db: Db, gebruiker: string | null, actie: string, entiteit?: string, entiteitId?: string | number, details?: unknown): void {
  db.run("INSERT INTO audit_log (gebruiker, actie, entiteit, entiteit_id, details) VALUES (?, ?, ?, ?, ?)", [
    gebruiker,
    actie,
    entiteit ?? null,
    entiteitId === undefined ? null : String(entiteitId),
    details === undefined ? null : JSON.stringify(details),
  ]);
}

export function getInstelling(db: Db, sleutel: string): string | undefined {
  return db.get<{ waarde: string }>("SELECT waarde FROM instellingen WHERE sleutel = ?", [sleutel])?.waarde;
}

export function setInstelling(db: Db, sleutel: string, waarde: string): void {
  db.run("INSERT INTO instellingen (sleutel, waarde) VALUES (?, ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde", [
    sleutel,
    waarde,
  ]);
}
