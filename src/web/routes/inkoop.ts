import { Router } from "express";
import multer from "multer";
import type { Ctx } from "../../lib/context.ts";
import { audit, GebruikersFout } from "../../lib/context.ts";
import { bewaarBijlage, MAX_BIJLAGE } from "../../lib/bijlagen.ts";
import { aiBeschikbaar, type AiVoorstel } from "../../integrations/ai/extract.ts";
import { btwCodes, eisOpenPeriode } from "../../modules/btw/service.ts";
import { factuurLijst, haalFactuur, nieuweInkoopfactuur, verwijderFactuur, werkFactuurBij, zetHandmatigBetaald } from "../../modules/facturen/service.ts";
import { categorieen, haalRelatie, relaties, slaRelatieOp } from "../../modules/relaties/service.ts";
import { haalTransactie } from "../../modules/bank/service.ts";
import { zetOmNaarVerkoop } from "../../modules/facturen/omzetten.ts";
import { isEigenLeverancier } from "../../modules/facturen/eigen.ts";
import { aanvullingen, koppelLeverancierAanFactuur, koppelOnbekendeLeveranciers, leverancierVelden, VELD_NAAM, vulLeverancierAan } from "../../modules/facturen/leverancier-uit-factuur.ts";
import { csrfNaUpload } from "../sessie.ts";
import { datum, geheel, idParam, klaar, lijst, regelsUitFormulier, render, tekst } from "../render.ts";
import type { Diensten } from "../diensten.ts";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BIJLAGE, files: 20, fields: 20 } });

export function inkoopRouter(ctx: Ctx, diensten: Diensten): Router {
  const r = Router();
  const gebruiker = (req: Express.Request) => req.sessie!.gebruikersnaam!;

  r.get("/", (req, res) => {
    const tab = req.query.tab === "geboekt" ? "geboekt" : "te_beoordelen";
    const filter = {
      status: tab,
      zoek: tekst(req.query.zoek, 100) ?? undefined,
      betaalstatus: (["onbetaald", "betaald"].includes(String(req.query.betaal)) ? req.query.betaal : undefined) as "onbetaald" | "betaald" | undefined,
    };
    render(ctx, req, res, "inkoop/lijst", {
      titel: "Inkoopfacturen",
      tab,
      facturen: factuurLijst(ctx, "inkoop", filter),
      aantalTeBeoordelen: ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM inkoopfacturen WHERE status = 'te_beoordelen'")!.n,
      ai: aiBeschikbaar(ctx),
    });
  });

  r.post("/upload", upload.array("bestanden", 20), csrfNaUpload, (req, res) => {
    const bestanden = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (bestanden.length === 0) throw new GebruikersFout("Kies één of meer PDF-bestanden");
    let nieuw = 0;
    const meldingen: string[] = [];
    for (const f of bestanden) {
      try {
        const b = bewaarBijlage(ctx, f.buffer, f.originalname);
        const bestaand = ctx.db.get<{ id: number }>("SELECT id FROM inkoopfacturen WHERE bijlage_sha256 = ?", [b.sha256]);
        if (bestaand) {
          meldingen.push(`${f.originalname}: al eerder geüpload (#${bestaand.id})`);
          continue;
        }
        nieuweInkoopfactuur(ctx, "upload", { bijlage: b.sha256, aiStatus: aiBeschikbaar(ctx) ? "wachtrij" : "overgeslagen", gebruiker: gebruiker(req) });
        nieuw++;
      } catch (e) {
        if (e instanceof GebruikersFout) meldingen.push(`${f.originalname}: ${e.message}`);
        else throw e;
      }
    }
    diensten.aiWachtrij();
    klaar(ctx, req, res, "/inkoop", `${nieuw} factuur/facturen toegevoegd.${meldingen.length ? ` ${meldingen.join("; ")}` : ""}`);
  });

  /** Meerdere te beoordelen items tegelijk weggooien (bv. geen factuur, of dubbel). */
  r.post("/verwijderen-selectie", (req, res) => {
    const ids = lijst<string>(req.body.ids).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) throw new GebruikersFout("Selecteer eerst één of meer facturen");
    let n = 0;
    const fouten: string[] = [];
    for (const id of ids) {
      try {
        verwijderFactuur(ctx, "inkoop", id, gebruiker(req));
        n++;
      } catch (e) {
        if (e instanceof GebruikersFout) fouten.push(`#${id}: ${e.message}`);
        else throw e;
      }
    }
    klaar(ctx, req, res, "/inkoop", `${n} verwijderd.${fouten.length ? ` Niet verwijderd: ${fouten.join("; ")}` : ""}`);
  });

  r.post("/nieuw", (req, res) => {
    const id = nieuweInkoopfactuur(ctx, "handmatig", { gebruiker: gebruiker(req) });
    res.redirect(`/inkoop/${id}`);
  });

  r.post("/outlook", async (req, res) => {
    const m = await diensten.outlookOphalen();
    klaar(ctx, req, res, "/inkoop", m ?? "Ophalen draait al.");
  });

  r.get("/:id", (req, res) => {
    const f = haalFactuur(ctx, "inkoop", idParam(req.params.id));
    if (!f) throw new GebruikersFout("Factuur niet gevonden", 404);
    const voorstel = f.ai_voorstel ? (JSON.parse(f.ai_voorstel) as AiVoorstel) : null;
    const koppelingen = ctx.db.all<{ transactie_id: number; bedrag: number }>("SELECT transactie_id, bedrag FROM transactie_koppelingen WHERE inkoopfactuur_id = ?", [f.id]).map((k) => ({
      ...k,
      transactie: haalTransactie(ctx, k.transactie_id),
    }));
    const email = f.email_bericht_id ? ctx.db.get("SELECT onderwerp, afzender, ontvangen_op FROM email_berichten WHERE id = ?", [f.email_bericht_id]) : null;
    render(ctx, req, res, "inkoop/detail", {
      titel: `Inkoopfactuur ${f.factuurnummer ?? `#${f.id}`}`,
      f,
      voorstel,
      email,
      koppelingen,
      relatie: f.relatie_id ? haalRelatie(ctx, f.relatie_id) : null,
      aanvulling: (() => {
        const rel = f.relatie_id ? haalRelatie(ctx, f.relatie_id) : null;
        if (!rel || !voorstel || f.status !== "te_beoordelen") return [];
        return Object.keys(aanvullingen(ctx, rel, voorstel)).map((k) => VELD_NAAM[k as keyof typeof VELD_NAAM]);
      })(),
      leveranciers: relaties(ctx, { type: "leverancier" }),
      categorieen: categorieen(ctx).filter((c) => c.soort !== "omzet"),
      btwCodes: btwCodes(ctx.db).filter((c) => c.soort !== "verkoop"),
      ai: aiBeschikbaar(ctx),
      eigenFactuur: !!voorstel && isEigenLeverancier(ctx, voorstel.leverancier),
      eigenNaamIngesteld: !!ctx.config.EIGEN_NAAM,
    });
  });

  r.post("/:id", (req, res) => {
    const id = idParam(req.params.id);
    const b = req.body as Record<string, unknown>;
    const boeken = b.actie === "boeken";
    werkFactuurBij(
      ctx,
      "inkoop",
      id,
      {
        relatie_id: geheel(b.relatie_id),
        factuurnummer: tekst(b.factuurnummer, 100),
        factuurdatum: datum(b.factuurdatum),
        vervaldatum: datum(b.vervaldatum),
        omschrijving: tekst(b.omschrijving),
        regels: regelsUitFormulier(b.regels),
      },
      { gebruiker: gebruiker(req), boeken },
    );
    if (boeken) {
      // Door naar de volgende te beoordelen factuur
      const volgende = ctx.db.get<{ id: number }>("SELECT id FROM inkoopfacturen WHERE status = 'te_beoordelen' ORDER BY id LIMIT 1");
      return klaar(ctx, req, res, volgende ? `/inkoop/${volgende.id}` : "/inkoop?tab=geboekt", "Factuur geboekt.");
    }
    klaar(ctx, req, res, `/inkoop/${id}`, "Opgeslagen.");
  });

  r.post("/:id/ai", (req, res) => {
    const id = idParam(req.params.id);
    if (!aiBeschikbaar(ctx)) throw new GebruikersFout("Claude is nog niet ingesteld (Instellingen → AI-uitlezen)");
    ctx.db.run("UPDATE inkoopfacturen SET ai_status = 'wachtrij', ai_melding = NULL WHERE id = ? AND status = 'te_beoordelen'", [id]);
    // Bestaande regels wissen zodat het nieuwe voorstel ze kan invullen
    ctx.db.run("DELETE FROM inkoopfactuur_regels WHERE factuur_id = ? AND (SELECT status FROM inkoopfacturen WHERE id = ?) = 'te_beoordelen'", [id, id]);
    diensten.aiWachtrij();
    klaar(ctx, req, res, `/inkoop/${id}`, "AI-uitlezen gestart; vernieuw de pagina over enkele seconden.");
  });

  /** Leverancier met één klik aanmaken uit het AI-voorstel en aan de factuur koppelen. */
  r.post("/:id/leverancier-uit-voorstel", (req, res) => {
    const id = idParam(req.params.id);
    const f = haalFactuur(ctx, "inkoop", id);
    if (!f?.ai_voorstel) throw new GebruikersFout("Geen AI-voorstel beschikbaar");
    const v = JSON.parse(f.ai_voorstel) as AiVoorstel;
    const relId = slaRelatieOp(ctx, null, leverancierVelden(ctx, v, f.regels), gebruiker(req));
    koppelLeverancierAanFactuur(ctx, id, relId);
    const n = koppelOnbekendeLeveranciers(ctx);
    klaar(ctx, req, res, `/inkoop/${id}`, `Leverancier "${v.leverancier.naam}" aangemaakt en gekoppeld.${n ? ` Ook ${n} andere factuur/facturen gekoppeld.` : ""}`);
  });

  /** Eigen factuur die bij de inkoop staat omzetten naar een verkoopfactuur (concept). */
  r.post("/:id/naar-verkoop", (req, res) => {
    const id = idParam(req.params.id);
    const o = zetOmNaarVerkoop(ctx, id, gebruiker(req));
    if (o.bestondAl) return klaar(ctx, req, res, `/verkoop/${o.verkoopId}`, "Deze factuur stond al bij de verkoop; de dubbele inkoopfactuur is verwijderd.");
    klaar(ctx, req, res, `/verkoop/${o.verkoopId}`, `Omgezet naar verkoopfactuur (concept)${o.klantAangemaakt ? `; klant "${o.klantAangemaakt}" aangemaakt` : ""}. Controleer en klik op Boeken.`);
  });

  /** Lege velden van de gekoppelde leverancier aanvullen met gegevens van de factuur. */
  r.post("/:id/leverancier-aanvullen", (req, res) => {
    const id = idParam(req.params.id);
    const f = haalFactuur(ctx, "inkoop", id);
    if (!f?.ai_voorstel || !f.relatie_id) throw new GebruikersFout("Geen leverancier of AI-voorstel");
    const velden = vulLeverancierAan(ctx, f.relatie_id, JSON.parse(f.ai_voorstel) as AiVoorstel, gebruiker(req));
    klaar(ctx, req, res, `/inkoop/${id}`, velden.length ? `Leverancier aangevuld: ${velden.join(", ")}.` : "Niets aan te vullen.");
  });

  r.post("/:id/betaald", (req, res) => {
    const id = idParam(req.params.id);
    zetHandmatigBetaald(ctx, "inkoop", id, req.body.ongedaan ? null : datum(req.body.datum, true), gebruiker(req));
    klaar(ctx, req, res, `/inkoop/${id}`, "Betaalstatus bijgewerkt.");
  });

  r.post("/:id/verwijderen", (req, res) => {
    verwijderFactuur(ctx, "inkoop", idParam(req.params.id), gebruiker(req));
    klaar(ctx, req, res, "/inkoop", "Factuur verwijderd.");
  });

  r.post("/:id/terug-naar-beoordelen", (req, res) => {
    const id = idParam(req.params.id);
    const f = haalFactuur(ctx, "inkoop", id);
    if (!f || f.status !== "geboekt") throw new GebruikersFout("Alleen geboekte facturen");
    eisOpenPeriode(ctx.db, f.factuurdatum);
    if (ctx.db.get("SELECT 1 FROM transactie_koppelingen WHERE inkoopfactuur_id = ?", [id])) throw new GebruikersFout("Ontkoppel eerst de banktransactie");
    ctx.db.run("UPDATE inkoopfacturen SET status = 'te_beoordelen', gewijzigd_op = ? WHERE id = ?", [new Date().toISOString(), id]);
    audit(ctx.db, gebruiker(req), "terug_naar_beoordelen", "inkoopfacturen", id);
    klaar(ctx, req, res, `/inkoop/${id}`, "Factuur staat weer op 'te beoordelen'.");
  });

  return r;
}
