import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../../lib/context.ts";
import { GebruikersFout } from "../../lib/context.ts";
import { btwCodes } from "../../modules/btw/service.ts";
import { categorieen, haalRelatie, relaties, slaRelatieOp, verwijderRelatie } from "../../modules/relaties/service.ts";
import { geheel, idParam, klaar, render, tekst } from "../render.ts";
import { factuurLijst, haalFactuur } from "../../modules/facturen/service.ts";
import { koppelDoorbelastingen, koppelLeverancierAanFactuur, koppelOnbekendeLeveranciers, leverancierVelden } from "../../modules/facturen/leverancier-uit-factuur.ts";
import type { AiVoorstel } from "../../integrations/ai/extract.ts";

export function relatiesRouter(ctx: Ctx): Router {
  const r = Router();
  const gebruiker = (req: Express.Request) => req.sessie!.gebruikersnaam!;
  const formData = () => ({ categorieen: categorieen(ctx), btwCodes: btwCodes(ctx.db) });

  r.get("/", (req, res) => {
    const type = req.query.type === "klant" || req.query.type === "leverancier" ? req.query.type : undefined;
    render(ctx, req, res, "relaties/lijst", { titel: "Relaties", relaties: relaties(ctx, { zoek: tekst(req.query.zoek, 100) ?? undefined, type }), type });
  });

  r.get("/nieuw", (req, res) => {
    // Vooringevuld vanuit een inkoopfactuur (gegevens die Claude uit de factuur haalde)
    const factuurId = geheel(req.query.uit_factuur);
    if (factuurId) {
      const f = haalFactuur(ctx, "inkoop", factuurId);
      if (!f?.ai_voorstel) throw new GebruikersFout("Deze factuur heeft geen AI-voorstel");
      const velden = leverancierVelden(ctx, JSON.parse(f.ai_voorstel) as AiVoorstel, f.regels);
      return render(ctx, req, res, "relaties/form", {
        titel: "Nieuwe leverancier uit factuur",
        r: velden,
        uitFactuur: factuurId,
        ...formData(),
      });
    }
    render(ctx, req, res, "relaties/form", { titel: "Nieuwe relatie", r: { type: req.query.type === "klant" ? "klant" : "leverancier", land: "NL" }, ...formData() });
  });

  r.post("/nieuw", (req, res) => {
    try {
      const id = slaRelatieOp(ctx, null, req.body, gebruiker(req));
      const factuurId = geheel(req.body.koppel_factuur);
      if (factuurId) {
        koppelLeverancierAanFactuur(ctx, factuurId, id);
        const n = koppelOnbekendeLeveranciers(ctx);
        return klaar(ctx, req, res, `/inkoop/${factuurId}`, `Leverancier aangemaakt en gekoppeld.${n ? ` Ook ${n} andere factuur/facturen van deze leverancier gekoppeld.` : ""}`);
      }
      const terug = typeof req.body.terug === "string" && /^\/(inkoop|verkoop)\/\d+$/.test(req.body.terug) ? req.body.terug : `/relaties/${id}`;
      const n = koppelOnbekendeLeveranciers(ctx);
      const d = koppelDoorbelastingen(ctx);
      if (d) ctx.log.info(`${d} inkoopregel(s) gekoppeld aan klant ${id}`);
      klaar(ctx, req, res, terug, `Relatie aangemaakt.${n ? ` ${n} te beoordelen factuur/facturen aan deze relatie gekoppeld.` : ""}`);
    } catch (e) {
      if (e instanceof z.ZodError) throw new GebruikersFout(e.issues.map((i) => i.message).join(", "));
      throw e;
    }
  });

  r.get("/:id", (req, res) => {
    const rel = haalRelatie(ctx, idParam(req.params.id));
    if (!rel) throw new GebruikersFout("Relatie niet gevonden", 404);
    render(ctx, req, res, "relaties/form", {
      titel: rel.naam,
      r: rel,
      inkoop: factuurLijst(ctx, "inkoop", { relatieId: rel.id, limiet: 50 }),
      verkoop: factuurLijst(ctx, "verkoop", { relatieId: rel.id, limiet: 50 }),
      ...formData(),
    });
  });

  r.post("/:id", (req, res) => {
    const id = idParam(req.params.id);
    try {
      slaRelatieOp(ctx, id, req.body, gebruiker(req));
    } catch (e) {
      if (e instanceof z.ZodError) throw new GebruikersFout(e.issues.map((i) => i.message).join(", "));
      throw e;
    }
    klaar(ctx, req, res, `/relaties/${id}`, "Opgeslagen.");
  });

  r.post("/:id/verwijderen", (req, res) => {
    verwijderRelatie(ctx, idParam(req.params.id), gebruiker(req));
    klaar(ctx, req, res, "/relaties", "Relatie verwijderd.");
  });

  return r;
}
