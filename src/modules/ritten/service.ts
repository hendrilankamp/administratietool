import { z } from "zod";
import type { Ctx } from "../../lib/context.ts";
import { audit, GebruikersFout } from "../../lib/context.ts";
import { isGeldigeDatum } from "../../lib/datum.ts";

/** Belastingvrije kilometervergoeding per km in centen (€ 0,25). Per rit overschrijfbaar. */
export const STANDAARD_TARIEF_CT = 25;

export const ritSchema = z.object({
  datum: z.string().refine(isGeldigeDatum, "Ongeldige datum"),
  van: z.string().trim().min(1, "Vul een vertrekplaats in").max(200),
  naar: z.string().trim().min(1, "Vul een bestemming in").max(200),
  doel: z.string().trim().min(1, "Vul het zakelijke doel in").max(300),
  relatie_id: z.number().int().positive().nullable().optional(),
  retour: z.boolean(),
  /** Kilometers van één traject; bij retour wordt dit verdubbeld. */
  kilometers: z.number().int().min(1, "Vul de kilometers in").max(5000),
  tarief_ct: z.number().int().min(0).max(200),
});
export type RitInvoer = z.infer<typeof ritSchema>;

export interface Rit {
  id: number;
  datum: string;
  van: string;
  naar: string;
  doel: string;
  relatie_id: number | null;
  relatie_naam: string | null;
  retour: number;
  kilometers: number;
  tarief_ct: number;
  /** Vergoeding in centen: kilometers x tarief. */
  bedrag: number;
}

export const ritBedrag = (kilometers: number, tariefCt: number): number => kilometers * tariefCt;

export function slaRitOp(ctx: Ctx, invoer: RitInvoer, gebruiker: string): number {
  const d = ritSchema.parse(invoer);
  const totaal = d.retour ? d.kilometers * 2 : d.kilometers;
  const r = ctx.db.run("INSERT INTO ritten (datum, van, naar, doel, relatie_id, retour, kilometers, tarief_ct) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    d.datum, d.van, d.naar, d.doel, d.relatie_id ?? null, d.retour ? 1 : 0, totaal, d.tarief_ct,
  ]);
  audit(ctx.db, gebruiker, "aangemaakt", "ritten", r.id, { ...d, totaal_km: totaal });
  return r.id;
}

export function verwijderRit(ctx: Ctx, id: number, gebruiker: string): void {
  const rit = ctx.db.get("SELECT * FROM ritten WHERE id = ?", [id]);
  if (!rit) throw new GebruikersFout("Rit niet gevonden", 404);
  ctx.db.run("DELETE FROM ritten WHERE id = ?", [id]);
  audit(ctx.db, gebruiker, "verwijderd", "ritten", id, rit);
}

export function ritten(ctx: Ctx, van: string, tot: string): Rit[] {
  return ctx.db
    .all<Omit<Rit, "bedrag">>(
      `SELECT t.*, r.naam AS relatie_naam FROM ritten t LEFT JOIN relaties r ON r.id = t.relatie_id
       WHERE t.datum BETWEEN ? AND ? ORDER BY t.datum DESC, t.id DESC`,
      [van, tot],
    )
    .map((t) => ({ ...t, bedrag: ritBedrag(t.kilometers, t.tarief_ct) }));
}

/** Totaal kilometers en vergoeding in een periode. */
export function ritTotaal(ctx: Ctx, van: string, tot: string): { kilometers: number; bedrag: number; aantal: number } {
  return ctx.db.get<{ kilometers: number; bedrag: number; aantal: number }>(
    "SELECT COALESCE(SUM(kilometers), 0) AS kilometers, COALESCE(SUM(kilometers * tarief_ct), 0) AS bedrag, COUNT(*) AS aantal FROM ritten WHERE datum BETWEEN ? AND ?",
    [van, tot],
  )!;
}

/** Tarief van de laatst ingevoerde rit, anders het standaardtarief. */
export function laatsteTarief(ctx: Ctx): number {
  return ctx.db.get<{ tarief_ct: number }>("SELECT tarief_ct FROM ritten ORDER BY id DESC LIMIT 1")?.tarief_ct ?? STANDAARD_TARIEF_CT;
}
