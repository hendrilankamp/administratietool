import { Router } from "express";
import type { Ctx } from "../../lib/context.ts";
import { GebruikersFout } from "../../lib/context.ts";
import { sha256 } from "../../lib/crypto.ts";
import { vandaag } from "../../lib/datum.ts";
import {
  autoAfletteren,
  bankregels,
  boekZonderFactuur,
  haalTransactie,
  koppel,
  ontbrekendeFacturen,
  ontkoppel,
  openPosten,
  pasRegelsToe,
  rekeningen,
  saldoControles,
  saldoOp,
  slaBankregelOp,
  slaRekeningOp,
  transacties,
  verwijderBankregel,
  voegSaldoControleToe,
  voorstellen,
  type Voorstel,
} from "../../modules/bank/service.ts";
import { categorieen } from "../../modules/relaties/service.ts";
import { bedrag, datum, geheel, idParam, klaar, render, tekst } from "../render.ts";

export const voorstelSleutel = (v: Voorstel) => sha256(JSON.stringify([v.soort, v.koppelingen, v.rest ?? null, v.categorieId ?? null])).slice(0, 16);

export function bankRouter(ctx: Ctx): Router {
  const r = Router();
  const gebruiker = (req: Express.Request) => req.sessie!.gebruikersnaam!;

  r.get("/", (req, res) => {
    const reks = rekeningen(ctx).map((rk) => ({ ...rk, saldo: saldoOp(ctx, rk.id, "9999-12-31"), controles: saldoControles(ctx, rk.id) }));
    render(ctx, req, res, "bank/overzicht", {
      titel: "Bank",
      rekeningen: reks,
      aantalOpen: ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM banktransacties WHERE status = 'open'")!.n,
      imports: ctx.db.all("SELECT b.*, r.naam AS rekening FROM import_batches b LEFT JOIN bankrekeningen r ON r.id = b.rekening_id ORDER BY b.id DESC LIMIT 10"),
      vandaag: vandaag(),
    });
  });

  r.post("/rekeningen", (req, res) => {
    const b = req.body as Record<string, string>;
    slaRekeningOp(ctx, geheel(b.id), { naam: b.naam ?? "", iban: b.iban ?? "", bank: tekst(b.bank, 50), beginsaldo: bedrag(b.beginsaldo || "0", "beginsaldo"), begindatum: datum(b.begindatum, true)! }, gebruiker(req));
    klaar(ctx, req, res, "/bank", "Rekening opgeslagen.");
  });

  r.post("/rekeningen/:id/saldo", (req, res) => {
    const c = voegSaldoControleToe(ctx, idParam(req.params.id), datum(req.body.datum, true)!, bedrag(req.body.saldo, "saldo"), gebruiker(req));
    klaar(ctx, req, res, "/bank", c.verschil === 0 ? "Saldo klopt." : `Let op: verschil van € ${(c.verschil / 100).toFixed(2)} met het berekende saldo.`);
  });

  r.get("/transacties", (req, res) => {
    const status = ["open", "gekoppeld", "geboekt_zonder_factuur"].includes(String(req.query.status)) ? String(req.query.status) : undefined;
    render(ctx, req, res, "bank/transacties", {
      titel: "Banktransacties",
      transacties: transacties(ctx, { status, zoek: tekst(req.query.zoek, 100) ?? undefined, rekeningId: geheel(req.query.rekening) ?? undefined }),
      rekeningen: rekeningen(ctx),
      status,
    });
  });

  r.get("/afletteren", (req, res) => {
    const posten = openPosten(ctx);
    const open = transacties(ctx, { status: "open", limiet: 50 });
    render(ctx, req, res, "bank/afletteren", {
      titel: "Af te letteren",
      items: open.map((t) => ({ t, voorstellen: voorstellen(ctx, t, posten).map((v) => ({ ...v, sleutel: voorstelSleutel(v) })) })),
      totaalOpen: ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM banktransacties WHERE status = 'open'")!.n,
      categorieen: categorieen(ctx),
    });
  });

  r.post("/auto", (req, res) => {
    const n = autoAfletteren(ctx, gebruiker(req));
    klaar(ctx, req, res, "/bank/afletteren", `${n} transactie(s) automatisch afgeletterd.`);
  });

  r.post("/regels/toepassen", (req, res) => {
    const n = pasRegelsToe(ctx, gebruiker(req));
    klaar(ctx, req, res, "/bank/afletteren", `${n} transactie(s) geboekt via bankregels.`);
  });

  r.get("/transacties/:id", (req, res) => {
    const t = haalTransactie(ctx, idParam(req.params.id));
    if (!t) throw new GebruikersFout("Transactie niet gevonden", 404);
    const zoek = (tekst(req.query.zoek, 100) ?? "").toLowerCase();
    const posten = openPosten(ctx)
      .filter((p) => Math.sign(p.bankBedrag) === Math.sign(t.bedrag) || t.koppelingen.length > 0)
      .filter((p) => !zoek || `${p.factuurnummer} ${p.relatie_naam}`.toLowerCase().includes(zoek))
      .slice(0, 50);
    render(ctx, req, res, "bank/transactie", {
      titel: "Transactie",
      t,
      voorstellen: voorstellen(ctx, t).map((v) => ({ ...v, sleutel: voorstelSleutel(v) })),
      posten,
      categorieen: categorieen(ctx),
      zoek,
    });
  });

  r.post("/transacties/:id/voorstel", (req, res) => {
    const id = idParam(req.params.id);
    const t = haalTransactie(ctx, id);
    if (!t) throw new GebruikersFout("Transactie niet gevonden", 404);
    const v = voorstellen(ctx, t).find((v) => voorstelSleutel(v) === req.body.sleutel);
    if (!v) throw new GebruikersFout("Dit voorstel is niet meer geldig; bekijk de transactie opnieuw.");
    if (v.soort === "regel" && v.categorieId) boekZonderFactuur(ctx, id, v.categorieId, v.titel, gebruiker(req));
    else koppel(ctx, id, v.koppelingen, { restCategorieId: v.rest?.categorieId, gebruiker: gebruiker(req) });
    klaar(ctx, req, res, typeof req.body.terug === "string" && req.body.terug === "afletteren" ? "/bank/afletteren" : `/bank/transacties/${id}`, "Gekoppeld.");
  });

  r.post("/transacties/:id/koppel", (req, res) => {
    const id = idParam(req.params.id);
    const soort = req.body.soort === "verkoop" ? "verkoop" : "inkoop";
    const factuurId = idParam(req.body.factuur_id);
    const t = haalTransactie(ctx, id);
    if (!t) throw new GebruikersFout("Transactie niet gevonden", 404);
    let b = tekst(req.body.bedrag) ? bedrag(req.body.bedrag) : null;
    if (b === null) {
      const p = openPosten(ctx).find((p) => p.soort === soort && p.id === factuurId);
      if (!p) throw new GebruikersFout("Factuur staat niet (meer) open");
      const rest = t.bedrag - (t.gekoppeld_bedrag ?? 0);
      b = Math.abs(p.bankBedrag) <= Math.abs(rest) ? p.bankBedrag : rest;
    } else if (soort === "inkoop" && b > 0 && t.bedrag < 0) b = -b; // gebruiker vult positief bedrag in
    const restCat = geheel(req.body.rest_categorie_id);
    koppel(ctx, id, [{ soort, factuurId, bedrag: b }], { restCategorieId: restCat ?? undefined, gebruiker: gebruiker(req) });
    klaar(ctx, req, res, `/bank/transacties/${id}`, "Gekoppeld.");
  });

  r.post("/transacties/:id/zonder-factuur", (req, res) => {
    const id = idParam(req.params.id);
    const cat = geheel(req.body.categorie_id);
    if (!cat) throw new GebruikersFout("Kies een categorie");
    boekZonderFactuur(ctx, id, cat, tekst(req.body.notitie, 500), gebruiker(req));
    if (req.body.regel_maken === "1") {
      const t = haalTransactie(ctx, id)!;
      const veld = t.tegenpartij_iban ? "iban" : "tegenpartij";
      const waarde = t.tegenpartij_iban ?? t.tegenpartij_naam;
      if (waarde) slaBankregelOp(ctx, { naam: t.tegenpartij_naam ?? waarde, veld, bevat: waarde, categorie_id: cat }, gebruiker(req));
    }
    klaar(ctx, req, res, req.body.terug === "afletteren" ? "/bank/afletteren" : `/bank/transacties/${id}`, "Geboekt zonder factuur.");
  });

  r.post("/transacties/:id/ontkoppel", (req, res) => {
    const id = idParam(req.params.id);
    ontkoppel(ctx, id, gebruiker(req));
    klaar(ctx, req, res, `/bank/transacties/${id}`, "Koppelingen verwijderd.");
  });

  r.get("/ontbrekend", (req, res) => {
    render(ctx, req, res, "bank/ontbrekend", { titel: "Factuur ontbreekt", transacties: ontbrekendeFacturen(ctx, 0, 3) });
  });

  r.get("/regels", (req, res) => {
    render(ctx, req, res, "bank/regels", { titel: "Bankregels", regels: bankregels(ctx), categorieen: categorieen(ctx) });
  });

  r.post("/regels", (req, res) => {
    const cat = geheel(req.body.categorie_id);
    if (!cat) throw new GebruikersFout("Kies een categorie");
    slaBankregelOp(ctx, { naam: String(req.body.naam ?? ""), veld: String(req.body.veld ?? ""), bevat: String(req.body.bevat ?? ""), categorie_id: cat }, gebruiker(req));
    klaar(ctx, req, res, "/bank/regels", "Regel toegevoegd.");
  });

  r.post("/regels/:id/verwijderen", (req, res) => {
    verwijderBankregel(ctx, idParam(req.params.id), gebruiker(req));
    klaar(ctx, req, res, "/bank/regels", "Regel verwijderd.");
  });

  return r;
}
