import type { NextFunction, Request, Response } from "express";
import type { Ctx } from "../lib/context.ts";
import { GebruikersFout } from "../lib/context.ts";
import { gelijk, sha256, willekeurigToken } from "../lib/crypto.ts";

export const COOKIE = "bh_sessie";
/** Double-submit CSRF-cookie voor formulieren zonder sessie (inloggen, setup). */
export const PRE_COOKIE = "bh_csrf";
const MAX_LEEFTIJD_MS = 12 * 3600 * 1000;

export interface Sessie {
  id: string;
  gebruiker_id: number | null;
  gebruikersnaam: string | null;
  fase: "2fa" | "volledig";
  csrf_token: string;
  flash: string | null;
  aangemaakt_op: string;
  laatst_actief: string;
}

export interface Flash {
  type: "ok" | "fout" | "info";
  tekst: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      sessie?: Sessie;
      preCsrf?: string;
    }
  }
}

function leesCookie(req: Request, naam: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const deel of header.split(";")) {
    const [k, ...v] = deel.trim().split("=");
    if (k === naam) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Secure-cookies bij HTTPS (direct of via reverse proxy met TRUST_PROXY), tenzij COOKIE_SECURE expliciet is gezet. */
export function cookieSecure(ctx: Ctx, req: Request): boolean {
  return ctx.config.COOKIE_SECURE ?? req.secure;
}

function zetCookie(ctx: Ctx, req: Request, res: Response, token: string | null): void {
  const delen = [`${COOKIE}=${token ?? ""}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  if (cookieSecure(ctx, req)) delen.push("Secure");
  if (token === null) delen.push("Max-Age=0");
  res.append("Set-Cookie", delen.join("; "));
}

/** Maakt een nieuwe sessie (altijd een nieuw ID na inloggen: voorkomt session fixation). */
export function nieuweSessie(ctx: Ctx, req: Request, res: Response, gebruikerId: number, fase: Sessie["fase"]): void {
  const token = willekeurigToken(32);
  const nu = new Date().toISOString();
  ctx.db.run("INSERT INTO sessies (id, gebruiker_id, fase, csrf_token, aangemaakt_op, laatst_actief) VALUES (?, ?, ?, ?, ?, ?)", [
    sha256(token),
    gebruikerId,
    fase,
    willekeurigToken(24),
    nu,
    nu,
  ]);
  zetCookie(ctx, req, res, token);
}

export function beeindigSessie(ctx: Ctx, req: Request, res: Response): void {
  if (req.sessie) ctx.db.run("DELETE FROM sessies WHERE id = ?", [req.sessie.id]);
  req.sessie = undefined;
  zetCookie(ctx, req, res, null);
}

/** Leest de sessie uit de cookie en controleert inactiviteit/maximale duur. */
export function sessieMiddleware(ctx: Ctx) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = leesCookie(req, COOKIE);
    if (token && /^[\w-]{20,100}$/.test(token)) {
      const s = ctx.db.get<Sessie>(
        "SELECT s.*, g.gebruikersnaam FROM sessies s LEFT JOIN gebruikers g ON g.id = s.gebruiker_id WHERE s.id = ?",
        [sha256(token)],
      );
      const nu = Date.now();
      if (s) {
        const inactief = nu - Date.parse(s.laatst_actief) > ctx.config.SESSIE_INACTIEF_MINUTEN * 60_000;
        const teOud = nu - Date.parse(s.aangemaakt_op) > MAX_LEEFTIJD_MS;
        if (inactief || teOud || !s.gebruiker_id) {
          ctx.db.run("DELETE FROM sessies WHERE id = ?", [s.id]);
          zetCookie(ctx, req, res, null);
        } else {
          req.sessie = s;
          if (nu - Date.parse(s.laatst_actief) > 30_000) ctx.db.run("UPDATE sessies SET laatst_actief = ? WHERE id = ?", [new Date(nu).toISOString(), s.id]);
        }
      }
    }
    if (!req.sessie) {
      const pre = leesCookie(req, PRE_COOKIE);
      if (pre && /^[\w-]{20,64}$/.test(pre)) req.preCsrf = pre;
      else {
        req.preCsrf = willekeurigToken(24);
        const delen = [`${PRE_COOKIE}=${req.preCsrf}`, "Path=/", "HttpOnly", "SameSite=Strict"];
        if (cookieSecure(ctx, req)) delen.push("Secure");
        res.append("Set-Cookie", delen.join("; "));
      }
    }
    next();
  };
}

export function zetFlash(ctx: Ctx, req: Request, f: Flash): void {
  if (req.sessie) ctx.db.run("UPDATE sessies SET flash = ? WHERE id = ?", [JSON.stringify(f), req.sessie.id]);
}

export function pakFlash(ctx: Ctx, req: Request): Flash | null {
  if (!req.sessie?.flash) return null;
  ctx.db.run("UPDATE sessies SET flash = NULL WHERE id = ?", [req.sessie.id]);
  try {
    return JSON.parse(req.sessie.flash) as Flash;
  } catch {
    return null;
  }
}

/** Alleen volledig ingelogde gebruikers (na 2FA). */
export function vereisLogin(req: Request, res: Response, next: NextFunction): void {
  if (req.sessie?.fase === "volledig") return next();
  if (req.method === "GET") res.redirect(`/login?terug=${encodeURIComponent(req.originalUrl)}`);
  else res.status(401).send("Niet ingelogd");
}

/** CSRF-controle voor alle muterende verzoeken. Multipart-formulieren controleren na het parsen (zie csrfNaUpload). */
export function csrfMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if ((req.headers["content-type"] ?? "").startsWith("multipart/form-data")) return next();
  controleerCsrf(req);
  next();
}

export function controleerCsrf(req: Request): void {
  const token = (req.body?._csrf as string | undefined) ?? (req.headers["x-csrf-token"] as string | undefined);
  const verwacht = req.sessie?.csrf_token ?? req.preCsrf;
  if (!verwacht || typeof token !== "string" || !gelijk(token, verwacht)) {
    throw new GebruikersFout("Ongeldig of verlopen formulier (CSRF). Laad de pagina opnieuw.", 403);
  }
}

export function csrfNaUpload(req: Request, _res: Response, next: NextFunction): void {
  controleerCsrf(req);
  next();
}

export function opruimenSessies(ctx: Ctx): void {
  const grens = new Date(Date.now() - Math.max(ctx.config.SESSIE_INACTIEF_MINUTEN * 60_000, MAX_LEEFTIJD_MS)).toISOString();
  ctx.db.run("DELETE FROM sessies WHERE laatst_actief < ?", [grens]);
  ctx.db.run("DELETE FROM inlogpogingen WHERE op < ?", [new Date(Date.now() - 7 * 86400000).toISOString()]);
}
