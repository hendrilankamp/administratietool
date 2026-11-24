import { z } from "zod";
import type { Ctx } from "../../lib/context.ts";
import { audit, GebruikersFout } from "../../lib/context.ts";
import { isGeldigeDatum } from "../../lib/datum.ts";
import { boekZonderFactuur } from "../bank/service.ts";

export const LENING_CATEGORIE = "Lening privé (aan de zaak)";

export const leningSchema = z.object({
  naam: z.string().trim().min(1, "Geef de lening een naam").max(100),
  startdatum: z.string().refine(isGeldigeDatum, "Ongeldige datum").nullable().optional(),
  rente_pct: z.number().min(0).max(100).nullable().optional(),
  notitie: z.string().trim().max(1000).nullable().optional(),
});
export type LeningInvoer = z.infer<typeof leningSchema>;

export interface Lening {
  id: number;
  naam: string;
  startdatum: string | null;
  rente_pct: number | null;
  notitie: string | null;
  afgesloten: number;
  /** Totaal geleend (stortingen). */
  geleend: number;
  /** Totaal afgelost. */
  afgelost: number;
  /** Nog af te lossen: geleend - afgelost. */
  openstaand: number;
}

export interface LeningBoeking {
  id: number;
  lening_id: number;
  datum: string;
  omschrijving: string | null;
  bedrag: number;
  transactie_id: number | null;
}

const SELECT = `SELECT l.*,
    COALESCE((SELECT SUM(b.bedrag) FROM lening_boekingen b WHERE b.lening_id = l.id AND b.bedrag > 0), 0) AS geleend,
    COALESCE((SELECT -SUM(b.bedrag) FROM lening_boekingen b WHERE b.lening_id = l.id AND b.bedrag < 0), 0) AS afgelost
  FROM leningen l`;

const metOpenstaand = (l: Omit<Lening, "openstaand">): Lening => ({ ...l, openstaand: l.geleend - l.afgelost });

export function leningen(ctx: Ctx): Lening[] {
  return ctx.db.all<Omit<Lening, "openstaand">>(`${SELECT} ORDER BY l.afgesloten, l.naam`).map(metOpenstaand);
}

export function haalLening(ctx: Ctx, id: number): Lening | null {
  const l = ctx.db.get<Omit<Lening, "openstaand">>(`${SELECT} WHERE l.id = ?`, [id]);
  return l ? metOpenstaand(l) : null;
}

/** Totaal nog af te lossen over alle niet-afgesloten leningen. */
export function totaalOpenstaand(ctx: Ctx): number {
  return leningen(ctx).filter((l) => !l.afgesloten).reduce((s, l) => s + l.openstaand, 0);
}

export function slaLeningOp(ctx: Ctx, invoer: LeningInvoer, gebruiker: string): number {
  const d = leningSchema.parse(invoer);
  const r = ctx.db.run("INSERT INTO leningen (naam, startdatum, rente_pct, notitie) VALUES (?, ?, ?, ?)", [d.naam, d.startdatum ?? null, d.rente_pct ?? null, d.notitie || null]);
  audit(ctx.db, gebruiker, "aangemaakt", "leningen", r.id, d);
  return r.id;
}

export function boekingen(ctx: Ctx, leningId: number): (LeningBoeking & { tegenpartij: string | null })[] {
  return ctx.db.all<LeningBoeking & { tegenpartij: string | null }>(
    `SELECT b.*, t.tegenpartij_naam AS tegenpartij FROM lening_boekingen b LEFT JOIN banktransacties t ON t.id = b.transactie_id
     WHERE b.lening_id = ? ORDER BY b.datum, b.id`,
    [leningId],
  );
}

/** Handmatige boeking (bv. beginstand, of zakelijk met privégeld betaald). Bedrag: + geleend, - afgelost. */
export function voegBoekingToe(ctx: Ctx, leningId: number, d: { datum: string; omschrijving: string | null; bedrag: number }, gebruiker: string): number {
  if (!haalLening(ctx, leningId)) throw new GebruikersFout("Lening niet gevonden", 404);
  if (!isGeldigeDatum(d.datum)) throw new GebruikersFout("Ongeldige datum");
  if (!Number.isInteger(d.bedrag) || d.bedrag === 0) throw new GebruikersFout("Vul een bedrag in");
  const r = ctx.db.run("INSERT INTO lening_boekingen (lening_id, datum, omschrijving, bedrag) VALUES (?, ?, ?, ?)", [leningId, d.datum, d.omschrijving, d.bedrag]);
  audit(ctx.db, gebruiker, "boeking_toegevoegd", "leningen", leningId, d);
  return r.id;
}

/** Alleen handmatige boekingen; een bankkoppeling haal je weg via 'Ontkoppelen' bij de transactie. */
export function verwijderBoeking(ctx: Ctx, leningId: number, boekingId: number, gebruiker: string): void {
  const b = ctx.db.get<LeningBoeking>("SELECT * FROM lening_boekingen WHERE id = ? AND lening_id = ?", [boekingId, leningId]);
  if (!b) throw new GebruikersFout("Boeking niet gevonden", 404);
  if (b.transactie_id) throw new GebruikersFout("Deze boeking komt van een banktransactie. Ontkoppel de transactie om hem te verwijderen.");
  ctx.db.run("DELETE FROM lening_boekingen WHERE id = ?", [boekingId]);
  audit(ctx.db, gebruiker, "boeking_verwijderd", "leningen", leningId, b);
}

/** Boekt een open banktransactie op een lening: bijschrijving = geleend, afschrijving = afgelost. */
export function boekTransactieOpLening(ctx: Ctx, transactieId: number, leningId: number, gebruiker: string): void {
  const l = haalLening(ctx, leningId);
  if (!l) throw new GebruikersFout("Lening niet gevonden", 404);
  const t = ctx.db.get<{ id: number; boekdatum: string; bedrag: number; tegenpartij_naam: string | null; omschrijving: string | null; status: string }>("SELECT * FROM banktransacties WHERE id = ?", [transactieId]);
  if (!t) throw new GebruikersFout("Transactie niet gevonden", 404);
  const cat = ctx.db.get<{ id: number }>("SELECT id FROM categorieen WHERE naam = ?", [LENING_CATEGORIE]);
  if (!cat) throw new GebruikersFout("Categorie voor leningen ontbreekt");
  if (ctx.db.get("SELECT 1 FROM lening_boekingen WHERE transactie_id = ?", [transactieId])) throw new GebruikersFout("Deze transactie staat al op een lening");
  if (ctx.db.get("SELECT 1 FROM transactie_koppelingen WHERE transactie_id = ?", [transactieId])) throw new GebruikersFout("Deze transactie is al aan een factuur gekoppeld");
  // Al als 'lening' gecategoriseerd (zonder lening gekoppeld): alleen de boeking toevoegen
  const alLening = (t as { categorie_id?: number | null }).categorie_id === cat.id;
  if (t.status !== "open" && !alLening) throw new GebruikersFout("Deze transactie is al afgehandeld; ontkoppel hem eerst");
  ctx.db.tx(() => {
    ctx.db.run("INSERT INTO lening_boekingen (lening_id, datum, omschrijving, bedrag, transactie_id) VALUES (?, ?, ?, ?, ?)", [
      leningId,
      t.boekdatum,
      (t.omschrijving ?? t.tegenpartij_naam ?? "").slice(0, 200) || null,
      t.bedrag,
      transactieId,
    ]);
    if (!alLening) boekZonderFactuur(ctx, transactieId, cat.id, `Lening: ${l.naam}`, gebruiker);
    audit(ctx.db, gebruiker, "transactie_op_lening", "leningen", leningId, { transactieId, bedrag: t.bedrag });
  });
}

/** Transacties die als 'Lening privé' zijn geboekt, maar nog niet aan een lening hangen (bv. via 'Boeken zonder factuur'). */
export function losseLeningTransacties(ctx: Ctx) {
  return ctx.db.all<{ id: number; boekdatum: string; bedrag: number; tegenpartij_naam: string | null; omschrijving: string | null }>(
    `SELECT t.id, t.boekdatum, t.bedrag, t.tegenpartij_naam, t.omschrijving FROM banktransacties t
     JOIN categorieen c ON c.id = t.categorie_id AND c.naam = ?
     WHERE NOT EXISTS (SELECT 1 FROM lening_boekingen b WHERE b.transactie_id = t.id) ORDER BY t.boekdatum DESC`,
    [LENING_CATEGORIE],
  );
}

export function zetAfgesloten(ctx: Ctx, id: number, afgesloten: boolean, gebruiker: string): void {
  if (!haalLening(ctx, id)) throw new GebruikersFout("Lening niet gevonden", 404);
  ctx.db.run("UPDATE leningen SET afgesloten = ? WHERE id = ?", [afgesloten ? 1 : 0, id]);
  audit(ctx.db, gebruiker, afgesloten ? "afgesloten" : "heropend", "leningen", id);
}

export function verwijderLening(ctx: Ctx, id: number, gebruiker: string): void {
  const l = haalLening(ctx, id);
  if (!l) throw new GebruikersFout("Lening niet gevonden", 404);
  if (ctx.db.get("SELECT 1 FROM lening_boekingen WHERE lening_id = ?", [id])) throw new GebruikersFout("Verwijder eerst de boekingen van deze lening, of sluit hem af");
  ctx.db.run("DELETE FROM leningen WHERE id = ?", [id]);
  audit(ctx.db, gebruiker, "verwijderd", "leningen", id, l);
}
