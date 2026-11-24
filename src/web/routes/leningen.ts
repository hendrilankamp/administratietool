import { Router } from "express";
import type { Ctx } from "../../lib/context.ts";
import { GebruikersFout } from "../../lib/context.ts";
import { vandaag } from "../../lib/datum.ts";
import { transacties } from "../../modules/bank/service.ts";
import { boekingen, boekTransactieOpLening, haalLening, leningen, losseLeningTransacties, slaLeningOp, totaalOpenstaand, verwijderBoeking, verwijderLening, voegBoekingToe, zetAfgesloten } from "../../modules/leningen/service.ts";
import { bedrag, datum, idParam, klaar, render, tekst } from "../render.ts";

export function leningenRouter(ctx: Ctx): Router {
  const r = Router();
  const gebruiker = (req: Express.Request) => req.sessie!.gebruikersnaam!;

  r.get("/", (req, res) => {
    render(ctx, req, res, "leningen/lijst", { titel: "Leningen", lijst: leningen(ctx), totaal: totaalOpenstaand(ctx), vandaag: vandaag(), losse: losseLeningTransacties(ctx) });
  });

  r.post("/", (req, res) => {
    const b = req.body as Record<string, unknown>;
    const rente = tekst(b.rente_pct, 10);
    const id = slaLeningOp(
      ctx,
      { naam: tekst(b.naam, 100) ?? "", startdatum: datum(b.startdatum), rente_pct: rente ? Number(rente.replace(",", ".")) : null, notitie: tekst(b.notitie) },
      gebruiker(req),
    );
    klaar(ctx, req, res, `/leningen/${id}`, "Lening aangemaakt. Voeg de beginstand of stortingen toe.");
  });

  r.get("/:id", (req, res) => {
    const l = haalLening(ctx, idParam(req.params.id));
    if (!l) throw new GebruikersFout("Lening niet gevonden", 404);
    const zoek = tekst(req.query.zoek, 100) ?? undefined;
    render(ctx, req, res, "leningen/detail", {
      titel: `Lening ${l.naam}`,
      l,
      boekingen: boekingen(ctx, l.id),
      open: transacties(ctx, { status: "open", zoek, limiet: 30 }).filter((t) => (t.gekoppeld_bedrag ?? 0) === 0),
      zoek: zoek ?? "",
      vandaag: vandaag(),
    });
  });

  r.post("/:id/boeking", (req, res) => {
    const id = idParam(req.params.id);
    const b = req.body as Record<string, unknown>;
    const centen = Math.abs(bedrag(b.bedrag));
    voegBoekingToe(ctx, id, { datum: datum(b.datum, true)!, omschrijving: tekst(b.omschrijving, 200), bedrag: b.soort === "afgelost" ? -centen : centen }, gebruiker(req));
    klaar(ctx, req, res, `/leningen/${id}`, "Boeking toegevoegd.");
  });

  r.post("/:id/boeking/:bid/verwijderen", (req, res) => {
    const id = idParam(req.params.id);
    verwijderBoeking(ctx, id, idParam(req.params.bid), gebruiker(req));
    klaar(ctx, req, res, `/leningen/${id}`, "Boeking verwijderd.");
  });

  r.post("/:id/transactie", (req, res) => {
    const id = idParam(req.params.id);
    boekTransactieOpLening(ctx, idParam(req.body.transactie_id), id, gebruiker(req));
    klaar(ctx, req, res, `/leningen/${id}`, "Banktransactie op de lening geboekt.");
  });

  r.post("/:id/afsluiten", (req, res) => {
    const id = idParam(req.params.id);
    zetAfgesloten(ctx, id, req.body.heropen !== "1", gebruiker(req));
    klaar(ctx, req, res, `/leningen/${id}`, "Bijgewerkt.");
  });

  r.post("/:id/verwijderen", (req, res) => {
    verwijderLening(ctx, idParam(req.params.id), gebruiker(req));
    klaar(ctx, req, res, "/leningen", "Lening verwijderd.");
  });

  return r;
}
