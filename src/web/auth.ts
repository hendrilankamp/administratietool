import fs from "node:fs";
import path from "node:path";
import { Router, type Request } from "express";
import qrcode from "qrcode-generator";
import type { Ctx } from "../lib/context.ts";
import { audit, GebruikersFout } from "../lib/context.ts";
import { controleerTotp, controleerWachtwoord, gelijk, hashWachtwoord, nieuwTotpGeheim, ontsleutel, totpUri, versleutel, willekeurigToken } from "../lib/crypto.ts";
import { beeindigSessie, nieuweSessie, vereisLogin, zetFlash } from "./sessie.ts";
import { render } from "./render.ts";

const MAX_POGINGEN = 5;
const BLOKKADE_MIN = 15;

interface Gebruiker {
  id: number;
  gebruikersnaam: string;
  wachtwoord_hash: string;
  totp_geheim: string | null;
  totp_actief: number;
}

let setupToken: string | null = null;

const setupTokenPad = (ctx: Ctx) => path.join(ctx.config.dataDir, "setup-token");

/**
 * Zolang er geen gebruiker is, geldt een setup-token. Het staat in de log én in DATA_DIR/setup-token
 * (te lezen via File Station) en blijft gelijk na een herstart. Na het aanmaken van de gebruiker vervalt het.
 */
export function initSetup(ctx: Ctx): void {
  const n = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM gebruikers")!.n;
  if (n > 0) {
    fs.rmSync(setupTokenPad(ctx), { force: true });
    return;
  }
  try {
    const bestaand = fs.readFileSync(setupTokenPad(ctx), "utf8").trim();
    if (/^[\w-]{12,64}$/.test(bestaand)) setupToken = bestaand;
  } catch {
    // nog geen token
  }
  if (!setupToken) {
    setupToken = willekeurigToken(12);
    fs.writeFileSync(setupTokenPad(ctx), `${setupToken}\n`, { mode: 0o600 });
  }
  ctx.log.warn(`Nog geen gebruiker. Open /setup en gebruik dit setup-token: ${setupToken} (staat ook in het bestand data/setup-token)`);
}

function ip(req: Request): string {
  return req.ip ?? "onbekend";
}

function geblokkeerd(ctx: Ctx, sleutel: string): boolean {
  const sinds = new Date(Date.now() - BLOKKADE_MIN * 60_000).toISOString();
  const n = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM inlogpogingen WHERE ip = ? AND gelukt = 0 AND op > ?", [sleutel, sinds])!.n;
  return n >= MAX_POGINGEN;
}

function registreerPoging(ctx: Ctx, sleutels: string[], gelukt: boolean): void {
  for (const s of sleutels) ctx.db.run("INSERT INTO inlogpogingen (ip, op, gelukt) VALUES (?, ?, ?)", [s, new Date().toISOString(), gelukt ? 1 : 0]);
}

function veiligeTerug(t: unknown): string {
  return typeof t === "string" && t.startsWith("/") && !t.startsWith("//") && !t.includes("\\") ? t : "/";
}

export function eisSterkWachtwoord(w: string): void {
  if (w.length < 12) throw new GebruikersFout("Wachtwoord moet minimaal 12 tekens zijn");
}

export function authRouter(ctx: Ctx): Router {
  const r = Router();

  r.get("/setup", (req, res) => {
    if (!setupToken) return res.redirect("/login");
    render(ctx, req, res, "auth/setup", { titel: "Eerste gebruiker aanmaken" });
  });

  r.post("/setup", (req, res) => {
    if (!setupToken) return res.redirect("/login");
    const { token, gebruikersnaam, wachtwoord, wachtwoord2 } = req.body as Record<string, string>;
    if (geblokkeerd(ctx, `setup:${ip(req)}`)) throw new GebruikersFout("Te veel pogingen; probeer het later opnieuw", 429);
    if (!token || !gelijk(token.trim(), setupToken)) {
      registreerPoging(ctx, [`setup:${ip(req)}`], false);
      throw new GebruikersFout("Ongeldig setup-token (zie de log van de container)");
    }
    if (!/^[\w.@-]{3,50}$/.test(gebruikersnaam ?? "")) throw new GebruikersFout("Gebruikersnaam: 3-50 tekens (letters, cijfers, . _ - @)");
    eisSterkWachtwoord(wachtwoord ?? "");
    if (wachtwoord !== wachtwoord2) throw new GebruikersFout("Wachtwoorden komen niet overeen");
    const id = ctx.db.run("INSERT INTO gebruikers (gebruikersnaam, wachtwoord_hash) VALUES (?, ?)", [gebruikersnaam, hashWachtwoord(wachtwoord)]).id;
    audit(ctx.db, gebruikersnaam, "gebruiker_aangemaakt", "gebruikers", id);
    setupToken = null;
    fs.rmSync(setupTokenPad(ctx), { force: true });
    nieuweSessie(ctx, req, res, id, "2fa");
    res.redirect("/login/2fa-instellen");
  });

  r.get("/login", (req, res) => {
    if (setupToken) return res.redirect("/setup");
    if (req.sessie?.fase === "volledig") return res.redirect("/");
    render(ctx, req, res, "auth/login", { titel: "Inloggen", terug: veiligeTerug(req.query.terug) });
  });

  r.post("/login", (req, res) => {
    const { gebruikersnaam = "", wachtwoord = "", terug } = req.body as Record<string, string>;
    const sleutels = [`ip:${ip(req)}`, `user:${gebruikersnaam.toLowerCase()}`];
    if (sleutels.some((s) => geblokkeerd(ctx, s))) {
      throw new GebruikersFout(`Te veel mislukte pogingen. Probeer het over ${BLOKKADE_MIN} minuten opnieuw.`, 429);
    }
    const g = ctx.db.get<Gebruiker>("SELECT * FROM gebruikers WHERE gebruikersnaam = ?", [gebruikersnaam]);
    // Altijd een hash uitrekenen, zodat de responstijd niet verraadt of een gebruiker bestaat
    const ok = controleerWachtwoord(wachtwoord, g?.wachtwoord_hash ?? "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    if (!g || !ok) {
      registreerPoging(ctx, sleutels, false);
      audit(ctx.db, gebruikersnaam, "inloggen_mislukt", "gebruikers", undefined, { ip: ip(req) });
      throw new GebruikersFout("Onjuiste gebruikersnaam of wachtwoord", 401);
    }
    beeindigSessie(ctx, req, res);
    nieuweSessie(ctx, req, res, g.id, "2fa");
    res.redirect(g.totp_actief ? `/login/2fa?terug=${encodeURIComponent(veiligeTerug(terug))}` : "/login/2fa-instellen");
  });

  r.get("/login/2fa", (req, res) => {
    if (!req.sessie) return res.redirect("/login");
    render(ctx, req, res, "auth/2fa", { titel: "Verificatiecode", terug: veiligeTerug(req.query.terug) });
  });

  r.post("/login/2fa", (req, res) => {
    if (!req.sessie || req.sessie.fase !== "2fa") return res.redirect("/login");
    const g = ctx.db.get<Gebruiker>("SELECT * FROM gebruikers WHERE id = ?", [req.sessie.gebruiker_id])!;
    const sleutel = `2fa:${g.id}`;
    if (geblokkeerd(ctx, sleutel)) {
      beeindigSessie(ctx, req, res);
      throw new GebruikersFout("Te veel onjuiste codes; log opnieuw in over 15 minuten.", 429);
    }
    if (!g.totp_actief || !g.totp_geheim) return res.redirect("/login/2fa-instellen");
    const geheim = ontsleutel(g.totp_geheim, ctx.config.APP_SECRET, "totp");
    if (!controleerTotp(geheim, String(req.body.code ?? ""))) {
      registreerPoging(ctx, [sleutel], false);
      throw new GebruikersFout("Onjuiste code", 401);
    }
    registreerPoging(ctx, [sleutel, `user:${g.gebruikersnaam.toLowerCase()}`], true);
    beeindigSessie(ctx, req, res);
    nieuweSessie(ctx, req, res, g.id, "volledig");
    audit(ctx.db, g.gebruikersnaam, "ingelogd", "gebruikers", g.id, { ip: ip(req) });
    res.redirect(veiligeTerug(req.body.terug));
  });

  // 2FA instellen: verplicht voordat de app gebruikt kan worden
  r.get("/login/2fa-instellen", (req, res) => {
    if (!req.sessie) return res.redirect("/login");
    const g = ctx.db.get<Gebruiker>("SELECT * FROM gebruikers WHERE id = ?", [req.sessie.gebruiker_id])!;
    // Een actieve 2FA kan alleen via de commandoregel worden gereset (npm run reset-2fa)
    if (g.totp_actief) return res.redirect(req.sessie.fase === "volledig" ? "/" : "/login/2fa");
    let geheim: string;
    if (g.totp_geheim) geheim = ontsleutel(g.totp_geheim, ctx.config.APP_SECRET, "totp");
    else {
      geheim = nieuwTotpGeheim();
      ctx.db.run("UPDATE gebruikers SET totp_geheim = ?, totp_actief = 0 WHERE id = ?", [versleutel(geheim, ctx.config.APP_SECRET, "totp"), g.id]);
    }
    const qr = qrcode(0, "M");
    qr.addData(totpUri(geheim, g.gebruikersnaam));
    qr.make();
    render(ctx, req, res, "auth/2fa-instellen", {
      titel: "Tweestapsverificatie instellen",
      qrSvg: qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true }),
      geheim: geheim.replace(/(.{4})/g, "$1 ").trim(),
    });
  });

  r.post("/login/2fa-instellen", (req, res) => {
    if (!req.sessie) return res.redirect("/login");
    const g = ctx.db.get<Gebruiker>("SELECT * FROM gebruikers WHERE id = ?", [req.sessie.gebruiker_id])!;
    if (g.totp_actief) return res.redirect(req.sessie.fase === "volledig" ? "/" : "/login/2fa");
    if (!g.totp_geheim) return res.redirect("/login/2fa-instellen");
    const geheim = ontsleutel(g.totp_geheim, ctx.config.APP_SECRET, "totp");
    if (!controleerTotp(geheim, String(req.body.code ?? ""))) throw new GebruikersFout("Onjuiste code; controleer de tijd op je telefoon en probeer opnieuw");
    ctx.db.run("UPDATE gebruikers SET totp_actief = 1 WHERE id = ?", [g.id]);
    audit(ctx.db, g.gebruikersnaam, "2fa_ingesteld", "gebruikers", g.id);
    beeindigSessie(ctx, req, res);
    nieuweSessie(ctx, req, res, g.id, "volledig");
    res.redirect("/");
  });

  r.post("/uitloggen", (req, res) => {
    beeindigSessie(ctx, req, res);
    res.redirect("/login");
  });

  r.post("/account/wachtwoord", vereisLogin, (req, res) => {
    const { huidig = "", nieuw = "", nieuw2 = "" } = req.body as Record<string, string>;
    const g = ctx.db.get<Gebruiker>("SELECT * FROM gebruikers WHERE id = ?", [req.sessie!.gebruiker_id])!;
    if (!controleerWachtwoord(huidig, g.wachtwoord_hash)) throw new GebruikersFout("Huidig wachtwoord klopt niet");
    eisSterkWachtwoord(nieuw);
    if (nieuw !== nieuw2) throw new GebruikersFout("Nieuwe wachtwoorden komen niet overeen");
    ctx.db.run("UPDATE gebruikers SET wachtwoord_hash = ? WHERE id = ?", [hashWachtwoord(nieuw), g.id]);
    ctx.db.run("DELETE FROM sessies WHERE gebruiker_id = ? AND id <> ?", [g.id, req.sessie!.id]);
    audit(ctx.db, g.gebruikersnaam, "wachtwoord_gewijzigd", "gebruikers", g.id);
    zetFlash(ctx, req, { type: "ok", tekst: "Wachtwoord gewijzigd; andere sessies zijn uitgelogd." });
    res.redirect("/instellingen");
  });

  return r;
}
