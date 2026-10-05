import type { Ctx } from "./context.ts";

export interface TaakStatus {
  naam: string;
  laatst_gestart: string | null;
  laatst_gelukt: string | null;
  laatste_fout: string | null;
  melding: string | null;
}

const bezig = new Set<string>();

/**
 * Voert een taak uit en legt start/succes/fout vast in `taak_status`.
 * Voorkomt dat dezelfde taak dubbel tegelijk draait.
 */
export async function voerTaakUit<T>(ctx: Ctx, naam: string, fn: () => Promise<T>, melding?: (r: T) => string): Promise<T | undefined> {
  if (bezig.has(naam)) {
    ctx.log.warn(`Taak ${naam} draait al, overgeslagen`);
    return undefined;
  }
  bezig.add(naam);
  const nu = new Date().toISOString();
  ctx.db.run(
    "INSERT INTO taak_status (naam, laatst_gestart) VALUES (?, ?) ON CONFLICT(naam) DO UPDATE SET laatst_gestart = excluded.laatst_gestart",
    [naam, nu],
  );
  try {
    const r = await fn();
    ctx.db.run("UPDATE taak_status SET laatst_gelukt = ?, laatste_fout = NULL, melding = ? WHERE naam = ?", [
      new Date().toISOString(),
      melding ? melding(r) : null,
      naam,
    ]);
    return r;
  } catch (e) {
    const bericht = e instanceof Error ? e.message : String(e);
    ctx.log.error(`Taak ${naam} mislukt: ${bericht}`);
    ctx.db.run("UPDATE taak_status SET laatste_fout = ? WHERE naam = ?", [`${new Date().toISOString()}: ${bericht}`.slice(0, 2000), naam]);
    throw e;
  } finally {
    bezig.delete(naam);
  }
}

export function taakStatus(ctx: Ctx, naam: string): TaakStatus | undefined {
  return ctx.db.get<TaakStatus>("SELECT * FROM taak_status WHERE naam = ?", [naam]);
}

export function alleTaakStatussen(ctx: Ctx): TaakStatus[] {
  return ctx.db.all<TaakStatus>("SELECT * FROM taak_status ORDER BY naam");
}

/** Eenvoudige interval-planner; fouten worden gelogd maar stoppen de planner niet. */
export class Planner {
  private timers: NodeJS.Timeout[] = [];
  private readonly ctx: Ctx;
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  elke(naam: string, ms: number, fn: () => Promise<unknown>, directNa?: number): void {
    const draai = () => voerTaakUit(this.ctx, naam, fn).catch(() => {});
    if (directNa !== undefined) this.timers.push(setTimeout(draai, directNa));
    this.timers.push(setInterval(draai, ms));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
