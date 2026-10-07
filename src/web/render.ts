import type { Request, Response } from "express";
import type { Ctx } from "../lib/context.ts";
import { GebruikersFout } from "../lib/context.ts";
import { euro, formatBedrag, invoerBedrag, parseBedrag } from "../lib/geld.ts";
import { isGeldigeDatum, nlDatum, nlTijdstip } from "../lib/datum.ts";
import { pakFlash, zetFlash } from "./sessie.ts";

export const helpers = { euro, formatBedrag, invoerBedrag, nlDatum, nlTijdstip };

export function render(ctx: Ctx, req: Request, res: Response, view: string, data: Record<string, unknown> = {}): void {
  const ingelogd = req.sessie?.fase === "volledig";
  const tellers = ingelogd
    ? ctx.db.get<{ inkoop: number; bank: number }>(
        "SELECT (SELECT COUNT(*) FROM inkoopfacturen WHERE status = 'te_beoordelen') AS inkoop, (SELECT COUNT(*) FROM banktransacties WHERE status = 'open') AS bank",
      )
    : null;
  res.render(view, {
    ...helpers,
    tellers,
    gebruiker: ingelogd ? req.sessie!.gebruikersnaam : null,
    csrf: req.sessie?.csrf_token ?? req.preCsrf ?? "",
    flash: pakFlash(ctx, req),
    pad: req.path,
    query: req.query,
    ...data,
  });
}

/** Na een geslaagde POST: melding tonen en terugsturen (Post/Redirect/Get). */
export function klaar(ctx: Ctx, req: Request, res: Response, naar: string, tekst?: string): void {
  if (tekst) zetFlash(ctx, req, { type: "ok", tekst });
  res.redirect(naar);
}

// ---------- Formulierwaarden ----------

export function tekst(v: unknown, max = 1000): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t.slice(0, max);
}

export function geheel(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

export function idParam(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new GebruikersFout("Ongeldig ID", 404);
  return n;
}

export function bedrag(v: unknown, veld = "bedrag"): number {
  const c = parseBedrag(typeof v === "string" ? v : null);
  if (c === null) throw new GebruikersFout(`Ongeldig ${veld}`);
  return c;
}

export function datum(v: unknown, verplicht = false): string | null {
  const t = tekst(v, 10);
  if (!t) {
    if (verplicht) throw new GebruikersFout("Datum is verplicht");
    return null;
  }
  if (!isGeldigeDatum(t)) throw new GebruikersFout(`Ongeldige datum: ${t}`);
  return t;
}

/** qs levert arrays soms als object met indexsleutels; dit maakt er altijd een array van. */
export function lijst<T = Record<string, unknown>>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object") return Object.keys(v as object).sort((a, b) => Number(a) - Number(b)).map((k) => (v as Record<string, T>)[k]);
  return [];
}

/** Factuurregels uit een formulier (bedragen als tekst in euro's). Lege regels worden overgeslagen. */
export function regelsUitFormulier(v: unknown) {
  return lijst<Record<string, string>>(v)
    .filter((r) => r && (tekst(r.bedrag_excl) || tekst(r.omschrijving)))
    .map((r, i) => {
      const excl = parseBedrag(r.bedrag_excl ?? "");
      if (excl === null) throw new GebruikersFout(`Ongeldig bedrag op regel ${i + 1}`);
      const btwTekst = tekst(r.btw_bedrag);
      const btw = btwTekst === null ? null : parseBedrag(btwTekst);
      if (btwTekst !== null && btw === null) throw new GebruikersFout(`Ongeldig BTW-bedrag op regel ${i + 1}`);
      return {
        omschrijving: tekst(r.omschrijving, 500),
        categorie_id: geheel(r.categorie_id),
        bedrag_excl: excl,
        btw_code: tekst(r.btw_code, 30) ?? "NL21",
        btw_bedrag: btw,
        doorbelast_relatie_id: geheel(r.doorbelast_relatie_id),
        doorbelast_naam: tekst(r.doorbelast_naam, 200),
        periode: tekst(r.periode, 100),
      };
    });
}
