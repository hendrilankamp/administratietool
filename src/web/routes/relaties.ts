import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../../lib/context.ts";
import { GebruikersFout } from "../../lib/context.ts";
import { btwCodes } from "../../modules/btw/service.ts";
import { factuurLijst } from "../../modules/facturen/service.ts";
import { categorieen, haalRelatie, relaties, slaRelatieOp, verwijderRelatie } from "../../modules/relaties/service.ts";
import { idParam, klaar, render, tekst } from "../render.ts";

export function relatiesRouter(ctx: Ctx): Router {
  const r = Router();
  const gebruiker = (req: Express.Request) => req.sessie!.gebruikersnaam!;
  const formData = () => ({ categorieen: categorieen(ctx), btwCodes: btwCodes(ctx.db) });

  r.get("/", (req, res) => {
    const type = req.query.type === "klant" || req.query.type === "leverancier" ? req.query.type : undefined;
    render(ctx, req, res, "relaties/lijst", { titel: "Relaties", relaties: relaties(ctx, { zoek: tekst(req.query.zoek, 100) ?? undefined, type }), type });
  });

  r.get("/nieuw", (req, res) => {
    render(ctx, req, res, "relaties/form", { titel: "Nieuwe relatie", r: { type: req.query.type === "klant" ? "klant" : "leverancier", land: "NL" }, ...formData() });
  });

  r.post("/nieuw", (req, res) => {
    try {
      const id = slaRelatieOp(ctx, null, req.body, gebruiker(req));
      const terug = typeof req.body.terug === "string" && /^\/(inkoop|verkoop)\/\d+$/.test(req.body.terug) ? req.body.terug : `/relaties/${id}`;
      klaar(ctx, req, res, terug, "Relatie aangemaakt.");
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
