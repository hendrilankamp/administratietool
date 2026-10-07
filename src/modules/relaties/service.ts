import { z } from "zod";
import type { Ctx } from "../../lib/context.ts";
import { audit, GebruikersFout } from "../../lib/context.ts";

export interface Relatie {
  id: number;
  naam: string;
  type: "klant" | "leverancier" | "beide";
  kvk: string | null;
  btw_nummer: string | null;
  iban: string | null;
  email: string | null;
  adres: string | null;
  postcode: string | null;
  plaats: string | null;
  land: string;
  standaard_categorie_id: number | null;
  standaard_btw_code: string | null;
  notities: string | null;
}

const leegNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const tekst = (max: number) => z.preprocess(leegNull, z.string().trim().max(max).nullable().optional());

export const relatieSchema = z.object({
  naam: z.string().trim().min(1, "Naam is verplicht").max(200),
  type: z.enum(["klant", "leverancier", "beide"]),
  kvk: tekst(20),
  btw_nummer: z.preprocess((v) => (typeof v === "string" ? normaliseerBtwNummer(v) || null : v), z.string().max(20).nullable().optional()),
  iban: z.preprocess((v) => (typeof v === "string" ? normaliseerIban(v) || null : v), z.string().max(34).nullable().optional()),
  email: z.preprocess(leegNull, z.email("Ongeldig e-mailadres").max(200).nullable().optional()),
  adres: tekst(200),
  postcode: tekst(20),
  plaats: tekst(100),
  land: z.preprocess((v) => (typeof v === "string" && v.trim() ? v.trim().toUpperCase() : "NL"), z.string().length(2)),
  standaard_categorie_id: z.preprocess((v) => (v === "" || v === null || v === undefined ? null : Number(v)), z.number().int().positive().nullable()),
  standaard_btw_code: tekst(30),
  notities: tekst(2000),
});
export type RelatieInvoer = { naam: string; type: string; [veld: string]: unknown };

export function normaliseerIban(s: string): string {
  return s.replace(/\s/g, "").toUpperCase();
}

export function normaliseerBtwNummer(s: string): string {
  return s.replace(/[\s.\-]/g, "").toUpperCase();
}

export function relaties(ctx: Ctx, filter: { zoek?: string; type?: "klant" | "leverancier" } = {}): Relatie[] {
  const waar: string[] = [];
  const p: string[] = [];
  if (filter.zoek) {
    waar.push("(naam LIKE ? OR iban LIKE ? OR btw_nummer LIKE ? OR email LIKE ?)");
    const z = `%${filter.zoek}%`;
    p.push(z, z, z, z);
  }
  if (filter.type) {
    waar.push("(type = ? OR type = 'beide')");
    p.push(filter.type);
  }
  return ctx.db.all<Relatie>(`SELECT * FROM relaties ${waar.length ? `WHERE ${waar.join(" AND ")}` : ""} ORDER BY naam COLLATE NOCASE`, p);
}

export function haalRelatie(ctx: Ctx, id: number): Relatie | undefined {
  return ctx.db.get<Relatie>("SELECT * FROM relaties WHERE id = ?", [id]);
}

export function slaRelatieOp(ctx: Ctx, id: number | null, invoer: RelatieInvoer, gebruiker: string): number {
  const d = relatieSchema.parse(invoer);
  const kolommen = [
    d.naam,
    d.type,
    d.kvk ?? null,
    d.btw_nummer ?? null,
    d.iban ?? null,
    d.email ?? null,
    d.adres ?? null,
    d.postcode ?? null,
    d.plaats ?? null,
    d.land,
    d.standaard_categorie_id,
    d.standaard_btw_code ?? null,
    d.notities ?? null,
  ];
  return ctx.db.tx(() => {
    if (id === null) {
      const r = ctx.db.run(
        `INSERT INTO relaties (naam, type, kvk, btw_nummer, iban, email, adres, postcode, plaats, land, standaard_categorie_id, standaard_btw_code, notities)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        kolommen,
      );
      audit(ctx.db, gebruiker, "aangemaakt", "relaties", r.id, d);
      return r.id;
    }
    const oud = haalRelatie(ctx, id);
    if (!oud) throw new GebruikersFout("Relatie niet gevonden", 404);
    ctx.db.run(
      `UPDATE relaties SET naam=?, type=?, kvk=?, btw_nummer=?, iban=?, email=?, adres=?, postcode=?, plaats=?, land=?,
         standaard_categorie_id=?, standaard_btw_code=?, notities=?, gewijzigd_op=? WHERE id=?`,
      [...kolommen, new Date().toISOString(), id],
    );
    audit(ctx.db, gebruiker, "gewijzigd", "relaties", id, { voor: oud, na: d });
    return id;
  });
}

export function verwijderRelatie(ctx: Ctx, id: number, gebruiker: string): void {
  const gebruikt = ctx.db.get<{ n: number }>(
    "SELECT (SELECT COUNT(*) FROM inkoopfacturen WHERE relatie_id = ?) + (SELECT COUNT(*) FROM verkoopfacturen WHERE relatie_id = ?) AS n",
    [id, id],
  )!.n;
  if (gebruikt > 0) throw new GebruikersFout("Deze relatie heeft facturen en kan niet worden verwijderd.");
  ctx.db.tx(() => {
    ctx.db.run("UPDATE bankregels SET relatie_id = NULL WHERE relatie_id = ?", [id]);
    ctx.db.run("DELETE FROM relaties WHERE id = ?", [id]);
    audit(ctx.db, gebruiker, "verwijderd", "relaties", id);
  });
}

export function normNaam(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(b\.?v\.?|v\.?o\.?f\.?|ltd|limited|inc|gmbh|llc|ireland|nederland|netherlands|holding|europe)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Zoekt de best passende bestaande relatie op BTW-nummer, IBAN of (genormaliseerde) naam. */
export function zoekRelatieMatch(ctx: Ctx, gegevens: { btw_nummer?: string | null; iban?: string | null; naam?: string | null }): Relatie | undefined {
  if (gegevens.btw_nummer) {
    const r = ctx.db.get<Relatie>("SELECT * FROM relaties WHERE btw_nummer = ?", [normaliseerBtwNummer(gegevens.btw_nummer)]);
    if (r) return r;
  }
  if (gegevens.iban) {
    const r = ctx.db.get<Relatie>("SELECT * FROM relaties WHERE iban = ?", [normaliseerIban(gegevens.iban)]);
    if (r) return r;
  }
  if (gegevens.naam) {
    const doel = normNaam(gegevens.naam);
    if (doel.length < 3) return undefined;
    return ctx.db.all<Relatie>("SELECT * FROM relaties").find((r) => {
      const n = normNaam(r.naam);
      return n === doel || (n.length >= 4 && (doel.startsWith(n) || n.startsWith(doel)));
    });
  }
  return undefined;
}

/** Zoekt een klant (of 'beide') op naam, ook als de naam een domein is (bv. "lunieq.nl" → "Lunieq"). */
export function zoekKlant(ctx: Ctx, naam: string): Relatie | undefined {
  const varianten = [naam, naam.replace(/^www\./i, "").replace(/\.(nl|com|eu|be|de|net|org|io)$/i, "")];
  const klanten = ctx.db.all<Relatie>("SELECT * FROM relaties WHERE type IN ('klant','beide')");
  for (const v of varianten) {
    const doel = normNaam(v);
    if (doel.length < 3) continue;
    const r = klanten.find((k) => {
      const n = normNaam(k.naam);
      const domein = k.email ? normNaam(k.email.split("@")[1]?.replace(/\.[a-z]+$/i, "") ?? "") : "";
      return n === doel || domein === doel || (n.length >= 4 && (doel.startsWith(n) || n.startsWith(doel)));
    });
    if (r) return r;
  }
  return undefined;
}

export function categorieen(ctx: Ctx, alleenActief = true) {
  return ctx.db.all<{ id: number; naam: string; soort: string; standaard_btw_code: string | null; actief: number }>(
    `SELECT * FROM categorieen ${alleenActief ? "WHERE actief = 1" : ""} ORDER BY soort, naam`,
  );
}
