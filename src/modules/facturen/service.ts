import { z } from "zod";
import type { Ctx } from "../../lib/context.ts";
import { audit, GebruikersFout } from "../../lib/context.ts";
import { isGeldigeDatum } from "../../lib/datum.ts";
import { btwCodeMap, eisOpenPeriode, regelBtw } from "../btw/service.ts";

export type Soort = "inkoop" | "verkoop";

export const TABEL = {
  inkoop: { factuur: "inkoopfacturen", regels: "inkoopfactuur_regels", betaald: "v_inkoop_betaald", betaaldKolom: "betaald_bank" },
  verkoop: { factuur: "verkoopfacturen", regels: "verkoopfactuur_regels", betaald: "v_verkoop_ontvangen", betaaldKolom: "ontvangen_bank" },
} as const;

const datum = z.string().refine(isGeldigeDatum, "Ongeldige datum");

export const regelSchema = z.object({
  omschrijving: z.string().trim().max(500).nullable().optional(),
  categorie_id: z.number().int().positive().nullable().optional(),
  bedrag_excl: z.number().int(),
  btw_code: z.string().min(1),
  btw_bedrag: z.number().int().nullable().optional(),
});
export type RegelInvoer = z.infer<typeof regelSchema>;

export const factuurSchema = z.object({
  relatie_id: z.number().int().positive().nullable().optional(),
  factuurnummer: z.string().trim().max(100).nullable().optional(),
  factuurdatum: datum.nullable().optional(),
  vervaldatum: datum.nullable().optional(),
  omschrijving: z.string().trim().max(1000).nullable().optional(),
  regels: z.array(regelSchema).max(200),
});
export type FactuurInvoer = z.infer<typeof factuurSchema>;

export interface Factuur {
  id: number;
  relatie_id: number | null;
  relatie_naam?: string | null;
  factuurnummer: string | null;
  factuurdatum: string | null;
  vervaldatum: string | null;
  omschrijving: string | null;
  valuta: string;
  totaal_excl: number;
  totaal_btw: number;
  totaal_incl: number;
  status: string;
  betaald_handmatig_op: string | null;
  bijlage_sha256: string | null;
  bron: string;
  geboekt_op: string | null;
  // inkoop
  ai_status?: string | null;
  ai_voorstel?: string | null;
  ai_melding?: string | null;
  email_bericht_id?: number | null;
  // verkoop
  mollie_id?: string | null;
  mollie_status?: string | null;
  mollie_betaald_op?: string | null;
  // afgeleid
  betaald_bank: number;
  openstaand: number;
  betaalstatus: "open" | "deels" | "betaald";
}

export interface Regel {
  id: number;
  factuur_id: number;
  volgorde: number;
  omschrijving: string | null;
  categorie_id: number | null;
  bedrag_excl: number;
  btw_code: string;
  btw_bedrag: number;
}

function betaalstatus(f: Omit<Factuur, "openstaand" | "betaalstatus">): Pick<Factuur, "openstaand" | "betaalstatus"> {
  const openstaand = f.totaal_incl - f.betaald_bank;
  const handmatig = !!f.betaald_handmatig_op || f.mollie_status === "paid";
  if (handmatig || (openstaand === 0 && f.totaal_incl !== 0)) return { openstaand: handmatig ? 0 : openstaand, betaalstatus: "betaald" };
  if (f.betaald_bank !== 0) return { openstaand, betaalstatus: "deels" };
  return { openstaand, betaalstatus: "open" };
}

function selectSql(soort: Soort): string {
  const t = TABEL[soort];
  return `SELECT f.*, r.naam AS relatie_naam, COALESCE(b.${t.betaaldKolom}, 0) AS betaald_bank
          FROM ${t.factuur} f
          LEFT JOIN relaties r ON r.id = f.relatie_id
          LEFT JOIN ${t.betaald} b ON b.factuur_id = f.id`;
}

function verrijk(rij: Omit<Factuur, "openstaand" | "betaalstatus">): Factuur {
  return { ...rij, ...betaalstatus(rij) };
}

export function haalFactuur(ctx: Ctx, soort: Soort, id: number): (Factuur & { regels: Regel[] }) | null {
  const rij = ctx.db.get<Omit<Factuur, "openstaand" | "betaalstatus">>(`${selectSql(soort)} WHERE f.id = ?`, [id]);
  if (!rij) return null;
  const regels = ctx.db.all<Regel>(`SELECT * FROM ${TABEL[soort].regels} WHERE factuur_id = ? ORDER BY volgorde, id`, [id]);
  return { ...verrijk(rij), regels };
}

export interface LijstFilter {
  status?: string;
  betaalstatus?: "open" | "deels" | "betaald" | "onbetaald";
  zoek?: string;
  van?: string;
  tot?: string;
  relatieId?: number;
  limiet?: number;
}

export function factuurLijst(ctx: Ctx, soort: Soort, filter: LijstFilter = {}): Factuur[] {
  const waar: string[] = [];
  const p: (string | number)[] = [];
  if (filter.status) {
    waar.push("f.status = ?");
    p.push(filter.status);
  }
  if (filter.zoek) {
    waar.push("(f.factuurnummer LIKE ? OR r.naam LIKE ? OR f.omschrijving LIKE ?)");
    const z = `%${filter.zoek}%`;
    p.push(z, z, z);
  }
  if (filter.van) {
    waar.push("f.factuurdatum >= ?");
    p.push(filter.van);
  }
  if (filter.tot) {
    waar.push("f.factuurdatum <= ?");
    p.push(filter.tot);
  }
  if (filter.relatieId) {
    waar.push("f.relatie_id = ?");
    p.push(filter.relatieId);
  }
  const sql = `${selectSql(soort)} ${waar.length ? `WHERE ${waar.join(" AND ")}` : ""}
               ORDER BY COALESCE(f.factuurdatum, substr(f.aangemaakt_op,1,10)) DESC, f.id DESC LIMIT ?`;
  p.push(filter.limiet ?? 500);
  let rijen = ctx.db.all<Omit<Factuur, "openstaand" | "betaalstatus">>(sql, p).map(verrijk);
  if (filter.betaalstatus === "onbetaald") rijen = rijen.filter((f) => f.betaalstatus !== "betaald");
  else if (filter.betaalstatus) rijen = rijen.filter((f) => f.betaalstatus === filter.betaalstatus);
  return rijen;
}

/** Valideert regels, berekent BTW en totalen. */
export function verwerkRegels(ctx: Ctx, soort: Soort, regels: RegelInvoer[]) {
  const codes = btwCodeMap(ctx.db);
  let excl = 0;
  let btw = 0;
  const uit = regels.map((r, i) => {
    const code = codes.get(r.btw_code);
    if (!code) throw new GebruikersFout(`Onbekende BTW-code op regel ${i + 1}: ${r.btw_code}`);
    if (code.soort !== "beide" && code.soort !== soort) throw new GebruikersFout(`BTW-code ${code.code} is niet bruikbaar voor ${soort}`);
    const b = regelBtw(code, r.bedrag_excl, r.btw_bedrag);
    excl += r.bedrag_excl;
    btw += b;
    return { ...r, btw_bedrag: b, volgorde: i };
  });
  return { regels: uit, totaal_excl: excl, totaal_btw: btw, totaal_incl: excl + btw };
}

export interface OpslaanOpties {
  gebruiker: string;
  boeken?: boolean; // status naar 'geboekt' (eist volledige gegevens)
}

/** Werkt kopgegevens + regels van een bestaande factuur bij. */
export function werkFactuurBij(ctx: Ctx, soort: Soort, id: number, invoer: FactuurInvoer, opties: OpslaanOpties): void {
  const t = TABEL[soort];
  const huidig = haalFactuur(ctx, soort, id);
  if (!huidig) throw new GebruikersFout("Factuur niet gevonden", 404);
  if (huidig.bron === "mollie") throw new GebruikersFout("Mollie-facturen worden beheerd in Mollie; alleen categorieën zijn aan te passen.");
  const data = factuurSchema.parse(invoer);
  const wordtGeboekt = opties.boeken || huidig.status === "geboekt";
  if (wordtGeboekt) {
    if (!data.relatie_id) throw new GebruikersFout("Kies een relatie (leverancier/klant)");
    if (!data.factuurdatum) throw new GebruikersFout("Factuurdatum is verplicht");
    if (data.regels.length === 0) throw new GebruikersFout("Voeg minimaal één regel toe");
    if (data.regels.some((r) => !r.categorie_id)) throw new GebruikersFout("Kies een categorie voor elke regel");
  }
  // Zowel de oude als de nieuwe datum moet in een open periode liggen.
  if (huidig.status === "geboekt") eisOpenPeriode(ctx.db, huidig.factuurdatum);
  if (wordtGeboekt) eisOpenPeriode(ctx.db, data.factuurdatum);

  const v = verwerkRegels(ctx, soort, data.regels);
  if (data.relatie_id && data.factuurnummer) {
    const dubbel = ctx.db.get<{ id: number }>(
      `SELECT id FROM ${t.factuur} WHERE relatie_id = ? AND factuurnummer = ? AND id <> ? AND status <> 'te_beoordelen' LIMIT 1`,
      [data.relatie_id, data.factuurnummer, id],
    );
    if (dubbel && wordtGeboekt) throw new GebruikersFout(`Factuurnummer ${data.factuurnummer} bestaat al voor deze relatie (factuur #${dubbel.id})`);
  }
  const nieuweStatus = wordtGeboekt ? "geboekt" : huidig.status;

  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE ${t.factuur} SET relatie_id = ?, factuurnummer = ?, factuurdatum = ?, vervaldatum = ?, omschrijving = ?,
         totaal_excl = ?, totaal_btw = ?, totaal_incl = ?, status = ?,
         geboekt_op = COALESCE(geboekt_op, CASE WHEN ? = 'geboekt' THEN ? END),
         gewijzigd_op = ?
       WHERE id = ?`,
      [
        data.relatie_id ?? null,
        data.factuurnummer || null,
        data.factuurdatum ?? null,
        data.vervaldatum ?? null,
        data.omschrijving || null,
        v.totaal_excl,
        v.totaal_btw,
        v.totaal_incl,
        nieuweStatus,
        nieuweStatus,
        new Date().toISOString(),
        new Date().toISOString(),
        id,
      ],
    );
    ctx.db.run(`DELETE FROM ${t.regels} WHERE factuur_id = ?`, [id]);
    for (const r of v.regels) {
      ctx.db.run(
        `INSERT INTO ${t.regels} (factuur_id, volgorde, omschrijving, categorie_id, bedrag_excl, btw_code, btw_bedrag) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, r.volgorde, r.omschrijving ?? null, r.categorie_id ?? null, r.bedrag_excl, r.btw_code, r.btw_bedrag],
      );
    }
    audit(ctx.db, opties.gebruiker, opties.boeken && huidig.status !== "geboekt" ? "geboekt" : "gewijzigd", t.factuur, id, {
      voor: { ...huidig, regels: huidig.regels },
      na: { ...data, ...v },
    });
  });
}

export function nieuweInkoopfactuur(
  ctx: Ctx,
  bron: "upload" | "email" | "handmatig",
  opties: { bijlage?: string; emailBerichtId?: number; aiStatus?: "wachtrij" | "overgeslagen"; gebruiker: string; omschrijving?: string },
): number {
  const r = ctx.db.run(
    `INSERT INTO inkoopfacturen (status, bron, bijlage_sha256, email_bericht_id, ai_status, omschrijving) VALUES ('te_beoordelen', ?, ?, ?, ?, ?)`,
    [bron, opties.bijlage ?? null, opties.emailBerichtId ?? null, opties.aiStatus ?? null, opties.omschrijving ?? null],
  );
  audit(ctx.db, opties.gebruiker, "aangemaakt", "inkoopfacturen", r.id, { bron, bijlage: opties.bijlage });
  return r.id;
}

export function nieuweVerkoopfactuur(ctx: Ctx, gebruiker: string): number {
  const r = ctx.db.run(`INSERT INTO verkoopfacturen (status, bron) VALUES ('concept', 'handmatig')`);
  audit(ctx.db, gebruiker, "aangemaakt", "verkoopfacturen", r.id);
  return r.id;
}

/** Alleen niet-geboekte facturen zonder bankkoppelingen mogen weg. */
export function verwijderFactuur(ctx: Ctx, soort: Soort, id: number, gebruiker: string): void {
  const f = haalFactuur(ctx, soort, id);
  if (!f) throw new GebruikersFout("Factuur niet gevonden", 404);
  if (f.status === "geboekt") throw new GebruikersFout("Een geboekte factuur kan niet worden verwijderd. Maak een creditfactuur.");
  const kolom = soort === "inkoop" ? "inkoopfactuur_id" : "verkoopfactuur_id";
  const kop = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM transactie_koppelingen WHERE ${kolom} = ?`, [id])!.n;
  if (kop > 0) throw new GebruikersFout("Deze factuur is gekoppeld aan een banktransactie; ontkoppel eerst.");
  ctx.db.tx(() => {
    ctx.db.run(`DELETE FROM ${TABEL[soort].factuur} WHERE id = ?`, [id]);
    audit(ctx.db, gebruiker, "verwijderd", TABEL[soort].factuur, id, f);
  });
}

export function zetHandmatigBetaald(ctx: Ctx, soort: Soort, id: number, datum: string | null, gebruiker: string): void {
  if (datum !== null && !isGeldigeDatum(datum)) throw new GebruikersFout("Ongeldige datum");
  const r = ctx.db.run(`UPDATE ${TABEL[soort].factuur} SET betaald_handmatig_op = ?, gewijzigd_op = ? WHERE id = ?`, [
    datum,
    new Date().toISOString(),
    id,
  ]);
  if (r.changes === 0) throw new GebruikersFout("Factuur niet gevonden", 404);
  audit(ctx.db, gebruiker, datum ? "handmatig_betaald" : "handmatig_betaald_ongedaan", TABEL[soort].factuur, id, { datum });
}

/** Alleen de categorie van regels wijzigen (bv. bij Mollie-facturen). */
export function zetRegelCategorieen(ctx: Ctx, soort: Soort, factuurId: number, categorieen: Record<number, number | null>, gebruiker: string): void {
  const f = haalFactuur(ctx, soort, factuurId);
  if (!f) throw new GebruikersFout("Factuur niet gevonden", 404);
  eisOpenPeriode(ctx.db, f.status === "geboekt" ? f.factuurdatum : null);
  ctx.db.tx(() => {
    for (const r of f.regels) {
      if (r.id in categorieen) {
        ctx.db.run(`UPDATE ${TABEL[soort].regels} SET categorie_id = ? WHERE id = ? AND factuur_id = ?`, [categorieen[r.id], r.id, factuurId]);
      }
    }
    audit(ctx.db, gebruiker, "categorieen_gewijzigd", TABEL[soort].factuur, factuurId, categorieen);
  });
}
