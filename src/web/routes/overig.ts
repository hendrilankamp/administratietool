import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import type { Ctx } from "../../lib/context.ts";
import { audit, GebruikersFout } from "../../lib/context.ts";
import { kwartaalVan, parseKwartaalId, vandaag } from "../../lib/datum.ts";
import { alleTaakStatussen, taakStatus } from "../../lib/taken.ts";
import { lijstBackups, maakBackup } from "../../backup/maak.ts";
import { bereidHerstelVoor, herstelKlaargezet } from "../../backup/herstel.ts";
import { AI_MODELLEN, aiBeschikbaar, aiKostenMaand } from "../../integrations/ai/extract.ts";
import { koppelStatus, ontkoppel, outlookIngesteld, startKoppelen } from "../../integrations/outlook/index.ts";
import { mollieIngesteld } from "../../integrations/mollie/index.ts";
import { berekenAangifte, heropenPeriode, RUBRIEK_OMSCHRIJVING, sluitPeriode, zorgVoorPeriode } from "../../modules/btw/service.ts";
import { factuurLijst } from "../../modules/facturen/service.ts";
import { categorieen } from "../../modules/relaties/service.ts";
import { dashboardCijfers, doorbelastingPerKlant, exportAccountant, winstEnVerlies } from "../../modules/rapportages/service.ts";
import { ontbrekendeFacturen } from "../../modules/bank/service.ts";
import { bedrag, geheel, idParam, klaar, render, tekst } from "../render.ts";
import type { Diensten } from "../diensten.ts";
import { koppelingenRoutes, koppelingInfo } from "./koppelingen.ts";
import { koppelDoorbelastingen } from "../../modules/facturen/leverancier-uit-factuur.ts";

export function dashboardRouter(ctx: Ctx): Router {
  const r = Router();
  r.get("/", async (req, res) => {
    const nu = vandaag();
    const { jaar, kwartaal } = kwartaalVan(nu);
    const laatsteBackup = lijstBackups(ctx.config.backupDir)[0] ?? null;
    render(ctx, req, res, "dashboard", {
      titel: "Overzicht",
      c: dashboardCijfers(ctx, jaar, kwartaal, nu),
      kwartaalId: `${jaar}-Q${kwartaal}`,
      laatsteBackup,
      backupOud: !laatsteBackup || Date.now() - laatsteBackup.datum.getTime() > 2 * 86400000,
      taken: alleTaakStatussen(ctx),
      outlook: outlookIngesteld(ctx) ? await koppelStatus(ctx) : null,
      ontbrekend: ontbrekendeFacturen(ctx, 0, 3).length,
      herstel: herstelKlaargezet(ctx.config),
      externUit: !!ctx.config.BACKUP_EXTERN_DIR && !(ctx.config.AGE_PASSPHRASE || ctx.config.AGE_RECIPIENT),
      nogInTeStellen: [
        !ctx.config.MOLLIE_TOKEN && "Mollie",
        !ctx.config.ANTHROPIC_API_KEY && "AI-uitlezen",
        !(ctx.config.MS_CLIENT_ID && ctx.config.MS_TENANT_ID) && "Outlook",
      ].filter(Boolean),
    });
  });
  return r;
}

export function btwRouter(ctx: Ctx): Router {
  const r = Router();
  const gebruiker = (req: Express.Request) => req.sessie!.gebruikersnaam!;

  r.get("/", (req, res) => {
    const { jaar, kwartaal } = kwartaalVan(vandaag());
    const lijst: { id: string; jaar: number; kwartaal: number; status: string; saldo: number }[] = [];
    for (let i = 0; i < 8; i++) {
      let k = kwartaal - i;
      let j = jaar;
      while (k < 1) {
        k += 4;
        j--;
      }
      const a = berekenAangifte(ctx.db, j, k);
      lijst.push({ id: a.periode.id, jaar: j, kwartaal: k, status: a.periode.status, saldo: a.teBetalenEuros });
    }
    render(ctx, req, res, "btw/lijst", { titel: "BTW-aangifte", lijst });
  });

  r.get("/:id", (req, res) => {
    const p = parseKwartaalId(String(req.params.id));
    if (!p) throw new GebruikersFout("Ongeldig kwartaal", 404);
    render(ctx, req, res, "btw/aangifte", { titel: `BTW ${req.params.id}`, a: berekenAangifte(ctx.db, p.jaar, p.kwartaal), omschrijving: RUBRIEK_OMSCHRIJVING });
  });

  r.post("/:id/correctie", (req, res) => {
    const p = parseKwartaalId(String(req.params.id));
    if (!p) throw new GebruikersFout("Ongeldig kwartaal", 404);
    const periode = zorgVoorPeriode(ctx.db, p.jaar, p.kwartaal);
    if (periode.status === "afgesloten") throw new GebruikersFout("Periode is afgesloten");
    const g = bedrag(req.body.grondslag || "0", "grondslag");
    const b = bedrag(req.body.btw || "0", "BTW");
    ctx.db.run("UPDATE perioden SET correctie_1d_grondslag = ?, correctie_1d_btw = ?, notitie = ? WHERE id = ?", [g, b, tekst(req.body.notitie, 1000), periode.id]);
    audit(ctx.db, gebruiker(req), "correctie_1d", "perioden", periode.id, { g, b });
    klaar(ctx, req, res, `/btw/${periode.id}`, "Correctie opgeslagen.");
  });

  r.post("/:id/afsluiten", (req, res) => {
    const id = String(req.params.id);
    if (!parseKwartaalId(id)) throw new GebruikersFout("Ongeldig kwartaal", 404);
    sluitPeriode(ctx.db, id);
    audit(ctx.db, gebruiker(req), "periode_afgesloten", "perioden", id);
    klaar(ctx, req, res, `/btw/${id}`, `Periode ${id} afgesloten.`);
  });

  r.post("/:id/heropenen", (req, res) => {
    const id = String(req.params.id);
    if (req.body.bevestig !== "HEROPEN") throw new GebruikersFout('Typ "HEROPEN" ter bevestiging');
    heropenPeriode(ctx.db, id);
    audit(ctx.db, gebruiker(req), "periode_heropend", "perioden", id);
    klaar(ctx, req, res, `/btw/${id}`, `Periode ${id} heropend. Dien zo nodig een suppletie in.`);
  });

  return r;
}

export function rapportagesRouter(ctx: Ctx): Router {
  const r = Router();
  r.get("/", (req, res) => {
    koppelDoorbelastingen(ctx);
    const jaar = geheel(req.query.jaar) ?? Number(vandaag().slice(0, 4));
    const kw = geheel(req.query.kwartaal);
    const van = kw ? `${jaar}-${String((kw - 1) * 3 + 1).padStart(2, "0")}-01` : `${jaar}-01-01`;
    const tot = kw ? berekenAangifte(ctx.db, jaar, kw).tot : `${jaar}-12-31`;
    const nu = vandaag();
    render(ctx, req, res, "rapportages", {
      titel: "Rapportages",
      jaar,
      kw,
      wv: winstEnVerlies(ctx, van, tot),
      doorbelasting: doorbelastingPerKlant(ctx, van, tot),
      debiteuren: factuurLijst(ctx, "verkoop", { status: "geboekt", betaalstatus: "onbetaald", limiet: 1000 }),
      crediteuren: factuurLijst(ctx, "inkoop", { status: "geboekt", betaalstatus: "onbetaald", limiet: 1000 }),
      vandaag: nu,
    });
  });

  r.get("/export/:jaar", async (req, res) => {
    const jaar = idParam(req.params.jaar);
    if (jaar < 2000 || jaar > 2100) throw new GebruikersFout("Ongeldig jaar");
    const pad = await exportAccountant(ctx, jaar);
    audit(ctx.db, req.sessie!.gebruikersnaam, "export_accountant", "rapportages", jaar);
    res.download(pad, path.basename(pad), () => fs.rmSync(path.dirname(pad), { recursive: true, force: true }));
  });
  return r;
}

export function instellingenRouter(ctx: Ctx, diensten: Diensten): Router {
  const r = Router();
  const gebruiker = (req: Express.Request) => req.sessie!.gebruikersnaam!;

  r.get("/", async (req, res) => {
    render(ctx, req, res, "instellingen", {
      titel: "Instellingen",
      outlook: outlookIngesteld(ctx) ? await koppelStatus(ctx) : { status: "niet_ingesteld" },
      mollie: mollieIngesteld(ctx),
      mollieTest: ctx.config.MOLLIE_TESTMODE,
      ai: aiBeschikbaar(ctx),
      aiModel: ctx.config.AI_MODEL,
      backups: lijstBackups(ctx.config.backupDir).slice(0, 40),
      extern: ctx.config.BACKUP_EXTERN_DIR ? lijstBackups(ctx.config.BACKUP_EXTERN_DIR, ".zip.age").slice(0, 10) : null,
      externIngesteld: !!ctx.config.BACKUP_EXTERN_DIR,
      ageIngesteld: !!(ctx.config.AGE_PASSPHRASE || ctx.config.AGE_RECIPIENT),
      testStatus: taakStatus(ctx, "testherstel"),
      backupStatus: taakStatus(ctx, "backup"),
      herstel: herstelKlaargezet(ctx.config),
      categorieen: categorieen(ctx, false),
      taken: alleTaakStatussen(ctx),
      config: { mailbox: ctx.config.MS_MAILBOX, map: ctx.config.MS_MAP, verwerkt: ctx.config.MS_MAP_VERWERKT, poll: ctx.config.MS_POLL_MINUTEN, backupUur: ctx.config.BACKUP_UUR },
      k: koppelingInfo(ctx),
      aiModellen: AI_MODELLEN,
      aiDezeMaand: aiKostenMaand(ctx),
      aiVorigeMaand: aiKostenMaand(ctx, new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15)),
      appSecretAutomatisch: ctx.config.appSecretAutomatisch,
    });
  });

  koppelingenRoutes(ctx, r);

  r.post("/outlook/koppelen", async (req, res) => {
    const s = await startKoppelen(ctx, gebruiker(req));
    if (s.status === "fout") throw new GebruikersFout(`Koppelen mislukt: ${s.melding}`);
    res.redirect("/instellingen#outlook");
  });

  r.post("/outlook/ontkoppelen", async (req, res) => {
    await ontkoppel(ctx, gebruiker(req));
    klaar(ctx, req, res, "/instellingen#outlook", "Outlook ontkoppeld.");
  });

  r.post("/backup", async (req, res) => {
    const b = await diensten.backupNu(`handmatig (${gebruiker(req)})`).catch((e: Error) => {
      throw new GebruikersFout(e.message);
    });
    klaar(ctx, req, res, "/instellingen#backups", b ? `Backup gemaakt: ${path.basename(b.bestand)}${b.extern ? " (+ versleutelde externe kopie)" : ""}` : "Er draait al een backup.");
  });

  r.post("/backup/test", async (req, res) => {
    const m = await diensten.testHerstel();
    klaar(ctx, req, res, "/instellingen#backups", m ?? "Testherstel draait al.");
  });

  r.get("/backup/download/:naam", (req, res) => {
    const naam = String(req.params.naam);
    const b = lijstBackups(ctx.config.backupDir).find((x) => x.naam === naam);
    if (!b) throw new GebruikersFout("Backup niet gevonden", 404);
    audit(ctx.db, gebruiker(req), "backup_gedownload", "backups", naam);
    res.download(b.pad, b.naam);
  });

  r.post("/backup/herstel", async (req, res) => {
    const naam = String(req.body.naam ?? "");
    if (req.body.bevestig !== "HERSTEL") throw new GebruikersFout('Typ "HERSTEL" ter bevestiging');
    const b = lijstBackups(ctx.config.backupDir).find((x) => x.naam === naam);
    if (!b) throw new GebruikersFout("Backup niet gevonden", 404);
    await maakBackup(ctx, `voor herstel (${gebruiker(req)})`);
    const r_ = await bereidHerstelVoor(ctx.config, b.pad);
    audit(ctx.db, gebruiker(req), "herstel_klaargezet", "backups", naam, { modus: r_.modus });
    klaar(ctx, req, res, "/instellingen#backups", `Herstel klaargezet vanuit ${naam}. De app herstart nu om het herstel uit te voeren; log daarna opnieuw in.`);
    setTimeout(() => diensten.herstart(), 1500);
  });

  r.post("/categorieen", (req, res) => {
    const naam = tekst(req.body.naam, 100);
    if (!naam) throw new GebruikersFout("Naam is verplicht");
    const soort = ["omzet", "kosten", "neutraal"].includes(req.body.soort) ? req.body.soort : "kosten";
    ctx.db.run("INSERT INTO categorieen (naam, soort, standaard_btw_code) VALUES (?, ?, ?)", [naam, soort, tekst(req.body.btw_code, 30)]);
    audit(ctx.db, gebruiker(req), "aangemaakt", "categorieen", naam);
    klaar(ctx, req, res, "/instellingen#categorieen", "Categorie toegevoegd.");
  });

  r.post("/categorieen/:id/actief", (req, res) => {
    const id = idParam(req.params.id);
    ctx.db.run("UPDATE categorieen SET actief = 1 - actief WHERE id = ?", [id]);
    audit(ctx.db, gebruiker(req), "actief_gewijzigd", "categorieen", id);
    klaar(ctx, req, res, "/instellingen#categorieen", "Categorie bijgewerkt.");
  });

  r.get("/audit", (req, res) => {
    const zoek = tekst(req.query.zoek, 100);
    render(ctx, req, res, "audit", {
      titel: "Audit-log",
      regels: ctx.db.all(
        `SELECT * FROM audit_log ${zoek ? "WHERE actie LIKE ? OR entiteit LIKE ? OR gebruiker LIKE ? OR entiteit_id = ?" : ""} ORDER BY id DESC LIMIT 300`,
        zoek ? [`%${zoek}%`, `%${zoek}%`, `%${zoek}%`, zoek] : [],
      ),
    });
  });

  return r;
}
