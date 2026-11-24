import { Router } from "express";
import type { Ctx } from "../../lib/context.ts";
import { GebruikersFout } from "../../lib/context.ts";
import { kwartaalGrenzen, vandaag } from "../../lib/datum.ts";
import { relaties } from "../../modules/relaties/service.ts";
import { laatsteTarief, ritTotaal, ritten, slaRitOp, verwijderRit } from "../../modules/ritten/service.ts";
import { datum, geheel, idParam, klaar, render, tekst } from "../render.ts";

export function ritRouter(ctx: Ctx): Router {
  const r = Router();
  const gebruiker = (req: Express.Request) => req.sessie!.gebruikersnaam!;

  r.get("/", (req, res) => {
    const jaar = geheel(req.query.jaar) ?? Number(vandaag().slice(0, 4));
    const kw = geheel(req.query.kwartaal);
    const { van, tot } = kw && kw >= 1 && kw <= 4 ? kwartaalGrenzen(jaar, kw) : { van: `${jaar}-01-01`, tot: `${jaar}-12-31` };
    const perKwartaal = [1, 2, 3, 4].map((k) => ({ k, ...ritTotaal(ctx, kwartaalGrenzen(jaar, k).van, kwartaalGrenzen(jaar, k).tot) }));
    render(ctx, req, res, "ritten/lijst", {
      titel: "Kilometers",
      jaar,
      kw: kw && kw >= 1 && kw <= 4 ? kw : null,
      lijst: ritten(ctx, van, tot),
      totaal: ritTotaal(ctx, van, tot),
      perKwartaal,
      klanten: relaties(ctx, { type: "klant" }),
      tarief: laatsteTarief(ctx),
      vandaag: vandaag(),
    });
  });

  r.post("/", (req, res) => {
    const b = req.body as Record<string, unknown>;
    const km = Number(String(b.kilometers ?? "").replace(",", ".").trim());
    const tarief = Number(String(b.tarief ?? "").replace(",", ".").trim());
    if (!Number.isFinite(km) || km <= 0) throw new GebruikersFout("Vul de kilometers in");
    if (!Number.isFinite(tarief) || tarief < 0) throw new GebruikersFout("Ongeldig tarief");
    slaRitOp(
      ctx,
      {
        datum: datum(b.datum, true)!,
        van: tekst(b.van, 200) ?? "",
        naar: tekst(b.naar, 200) ?? "",
        doel: tekst(b.doel, 300) ?? "",
        relatie_id: geheel(b.relatie_id),
        retour: b.retour === "1",
        kilometers: Math.round(km),
        tarief_ct: Math.round(tarief * 100),
      },
      gebruiker(req),
    );
    klaar(ctx, req, res, `/ritten?jaar=${String(b.datum).slice(0, 4)}`, "Rit opgeslagen.");
  });

  r.post("/:id/verwijderen", (req, res) => {
    verwijderRit(ctx, idParam(req.params.id), gebruiker(req));
    klaar(ctx, req, res, "/ritten", "Rit verwijderd.");
  });

  return r;
}
