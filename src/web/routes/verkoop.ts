import { Router } from "express";
import type { Ctx } from "../../lib/context.ts";
import { mollieIngesteld, verrekenCreditnota } from "../../integrations/mollie/index.ts";
import { audit, GebruikersFout } from "../../lib/context.ts";
import { eisOpenPeriode } from "../../modules/btw/service.ts";
import { btwCodes } from "../../modules/btw/service.ts";
import { factuurLijst, haalFactuur, nieuweVerkoopfactuur, verwijderFactuur, werkFactuurBij, zetHandmatigBetaald, zetRegelCategorieen, zetRegelPerioden } from "../../modules/facturen/service.ts";
import { haalTransactie } from "../../modules/bank/service.ts";
import { categorieen, haalRelatie, relaties } from "../../modules/relaties/service.ts";
import { datum, geheel, idParam, klaar, periodeUitFormulier, regelsUitFormulier, render, tekst } from "../render.ts";
import type { Diensten } from "../diensten.ts";

export function verkoopRouter(ctx: Ctx, diensten: Diensten): Router {
  const r = Router();
  const gebruiker = (req: Express.Request) => req.sessie!.gebruikersnaam!;

  r.get("/", (req, res) => {
    const betaal = ["onbetaald", "betaald"].includes(String(req.query.betaal)) ? (req.query.betaal as "onbetaald" | "betaald") : undefined;
    render(ctx, req, res, "verkoop/lijst", {
      titel: "Verkoopfacturen",
      facturen: factuurLijst(ctx, "verkoop", { zoek: tekst(req.query.zoek, 100) ?? undefined, betaalstatus: betaal }).filter(
        (f) => req.query.geannuleerd === "1" || f.status !== "vervallen",
      ),
      aantalGeannuleerd: ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM verkoopfacturen WHERE status = 'vervallen'")!.n,
      mollie: mollieIngesteld(ctx),
    });
  });

  r.post("/mollie-sync", async (req, res) => {
    const m = await diensten.mollieSync().catch((e: Error) => {
      throw new GebruikersFout(`Mollie-synchronisatie mislukt: ${e.message}`, 502);
    });
    klaar(ctx, req, res, "/verkoop", m ? `Mollie: ${m}` : "Synchronisatie draait al.");
  });

  r.post("/nieuw", (req, res) => {
    res.redirect(`/verkoop/${nieuweVerkoopfactuur(ctx, gebruiker(req))}`);
  });

  r.get("/:id", (req, res) => {
    const f = haalFactuur(ctx, "verkoop", idParam(req.params.id));
    if (!f) throw new GebruikersFout("Factuur niet gevonden", 404);
    const koppelingen = ctx.db
      .all<{ transactie_id: number; bedrag: number }>("SELECT transactie_id, bedrag FROM transactie_koppelingen WHERE verkoopfactuur_id = ?", [f.id])
      .map((k) => ({ ...k, transactie: haalTransactie(ctx, k.transactie_id) }));
    render(ctx, req, res, "verkoop/detail", {
      titel: `Verkoopfactuur ${f.factuurnummer ?? `#${f.id}`}`,
      f,
      koppelingen,
      relatie: f.relatie_id ? haalRelatie(ctx, f.relatie_id) : null,
      klanten: relaties(ctx, { type: "klant" }),
      verrekenOpties: f.is_creditnota && !f.creditnota_voor && f.relatie_id
        ? ctx.db.all<{ id: number; factuurnummer: string | null; totaal_incl: number; factuurdatum: string | null }>(
            "SELECT id, factuurnummer, totaal_incl, factuurdatum FROM verkoopfacturen WHERE relatie_id = ? AND is_creditnota = 0 AND status = 'geboekt' AND id <> ? ORDER BY factuurdatum DESC LIMIT 50",
            [f.relatie_id, f.id],
          )
        : [],
      creditVoor: f.creditnota_voor ? ctx.db.get<{ id: number; factuurnummer: string | null }>("SELECT id, factuurnummer FROM verkoopfacturen WHERE id = ?", [f.creditnota_voor]) : null,
      categorieen: categorieen(ctx).filter((c) => c.soort !== "kosten"),
      btwCodes: btwCodes(ctx.db).filter((c) => c.soort !== "inkoop"),
    });
  });

  r.post("/:id", (req, res) => {
    const id = idParam(req.params.id);
    const b = req.body as Record<string, unknown>;
    const f = haalFactuur(ctx, "verkoop", id);
    if (!f) throw new GebruikersFout("Factuur niet gevonden", 404);
    if (f.bron === "mollie") {
      const cats: Record<number, number | null> = {};
      for (const [k, v] of Object.entries((b.categorie ?? {}) as Record<string, string>)) cats[Number(k)] = geheel(v);
      // Categorieën alleen opslaan als ze veranderd zijn (kan niet in een afgesloten periode; perioden wel)
      if (f.regels.some((r) => r.id in cats && cats[r.id] !== r.categorie_id)) zetRegelCategorieen(ctx, "verkoop", id, cats, gebruiker(req));
      const perioden: Record<number, { van: string | null; tot: string | null }> = {};
      const vans = (b.periode_van ?? {}) as Record<string, string>;
      const tots = (b.periode_tot ?? {}) as Record<string, string>;
      for (const k of new Set([...Object.keys(vans), ...Object.keys(tots)])) {
        const p = periodeUitFormulier(vans[k], tots[k]);
        perioden[Number(k)] = { van: p.periode_van, tot: p.periode_tot };
      }
      zetRegelPerioden(ctx, "verkoop", id, perioden, gebruiker(req));
      return klaar(ctx, req, res, `/verkoop/${id}`, "Categorieën en perioden opgeslagen.");
    }
    werkFactuurBij(
      ctx,
      "verkoop",
      id,
      {
        relatie_id: geheel(b.relatie_id),
        factuurnummer: tekst(b.factuurnummer, 100),
        factuurdatum: datum(b.factuurdatum),
        vervaldatum: datum(b.vervaldatum),
        omschrijving: tekst(b.omschrijving),
        regels: regelsUitFormulier(b.regels),
      },
      { gebruiker: gebruiker(req), boeken: b.actie === "boeken" },
    );
    klaar(ctx, req, res, `/verkoop/${id}`, b.actie === "boeken" ? "Factuur geboekt." : "Opgeslagen.");
  });

  /** Mollie-factuur die je in Mollie hebt geannuleerd/verwijderd maar die Mollie nog als uitgegeven meldt. */
  r.post("/:id/lokaal-annuleren", (req, res) => {
    const id = idParam(req.params.id);
    const f = haalFactuur(ctx, "verkoop", id);
    if (!f) throw new GebruikersFout("Factuur niet gevonden", 404);
    eisOpenPeriode(ctx.db, f.factuurdatum);
    if (ctx.db.get("SELECT 1 FROM transactie_koppelingen WHERE verkoopfactuur_id = ?", [id])) throw new GebruikersFout("Ontkoppel eerst de banktransactie");
    const terug = req.body.ongedaan === "1";
    ctx.db.run("UPDATE verkoopfacturen SET status = ?, lokaal_geannuleerd = ?, gewijzigd_op = ? WHERE id = ?", [terug ? "geboekt" : "vervallen", terug ? 0 : 1, new Date().toISOString(), id]);
    audit(ctx.db, gebruiker(req), terug ? "annulering_ongedaan" : "lokaal_geannuleerd", "verkoopfacturen", id);
    klaar(ctx, req, res, `/verkoop/${id}`, terug ? "Factuur weer actief." : "Factuur als geannuleerd gemarkeerd; telt niet meer mee voor omzet en BTW. Mollie-synchronisatie zet hem niet terug.");
  });

  /** Creditnota verrekenen met de oorspronkelijke factuur (beide afgehandeld). */
  r.post("/:id/verreken", (req, res) => {
    const id = idParam(req.params.id);
    const origineel = idParam(req.body.factuur_id);
    const doel = verrekenCreditnota(ctx, id, origineel, gebruiker(req));
    if (!doel) throw new GebruikersFout("Verrekenen niet gelukt (alleen geboekte creditnota's)");
    klaar(ctx, req, res, `/verkoop/${id}`, "Creditnota verrekend met de factuur; beide staan niet meer open.");
  });

  r.post("/:id/betaald", (req, res) => {
    const id = idParam(req.params.id);
    zetHandmatigBetaald(ctx, "verkoop", id, req.body.ongedaan ? null : datum(req.body.datum, true), gebruiker(req));
    klaar(ctx, req, res, `/verkoop/${id}`, "Betaalstatus bijgewerkt.");
  });

  r.post("/:id/verwijderen", (req, res) => {
    verwijderFactuur(ctx, "verkoop", idParam(req.params.id), gebruiker(req));
    klaar(ctx, req, res, "/verkoop", "Concept verwijderd.");
  });

  return r;
}
