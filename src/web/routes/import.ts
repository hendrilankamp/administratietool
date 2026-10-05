import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Ctx } from "../../lib/context.ts";
import { GebruikersFout } from "../../lib/context.ts";
import type { DatumFormaat } from "../../lib/datum.ts";
import { autoAfletteren, rekeningen } from "../../modules/bank/service.ts";
import { BANK_VELDEN, RELATIE_VELDEN, VELD_LABEL, type Doel, type Profiel, type ProfielConfig } from "../../modules/csv-import/profielen.ts";
import { alleProfielen, analyseer, bewaarUpload, draaiImportTerug, importeer, leesUpload, MAX_CSV, slaProfielOp, verwijderUpload, vindProfiel } from "../../modules/csv-import/service.ts";
import { csrfNaUpload } from "../sessie.ts";
import { geheel, idParam, klaar, render, tekst } from "../render.ts";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CSV, files: 1, fields: 20 } });
const DATUMFORMATEN: DatumFormaat[] = ["YYYY-MM-DD", "DD-MM-YYYY", "DD/MM/YYYY", "DD.MM.YYYY", "MM/DD/YYYY", "YYYYMMDD"];

/** Leest een aangepaste mapping uit het formulier. */
function profielUitFormulier(doel: Doel, b: Record<string, unknown>): Profiel {
  const velden = doel === "banktransacties" ? BANK_VELDEN : RELATIE_VELDEN;
  const kolommen: ProfielConfig["kolommen"] = {};
  const map = (b.kolom ?? {}) as Record<string, string | string[]>;
  for (const v of velden) {
    const w = map[v];
    const lijst = (Array.isArray(w) ? w : w ? [w] : []).filter((x) => typeof x === "string" && x !== "");
    if (lijst.length) kolommen[v] = lijst;
  }
  const datumFormaat = DATUMFORMATEN.includes(b.datumFormaat as DatumFormaat) ? (b.datumFormaat as DatumFormaat) : "DD-MM-YYYY";
  const bedragModus = (["een_kolom", "bij_af", "indicator"].includes(String(b.bedragModus)) ? b.bedragModus : "een_kolom") as ProfielConfig["bedragModus"];
  return {
    naam: tekst(b.profielnaam, 100) ?? "Aangepast",
    ingebouwd: false,
    config: {
      doel,
      decimaal: b.decimaal === "." ? "." : ",",
      datumFormaat,
      bedragModus,
      afWaarde: tekst(b.afWaarde, 20) ?? undefined,
      kolommen,
      herkenning: Object.values(kolommen).flat().slice(0, 4) as string[],
    },
  };
}

export function importRouter(ctx: Ctx): Router {
  const r = Router();
  const gebruiker = (req: Express.Request) => req.sessie!.gebruikersnaam!;

  r.get("/", (req, res) => {
    render(ctx, req, res, "import/start", {
      titel: "CSV importeren",
      rekeningen: rekeningen(ctx),
      profielen: alleProfielen(ctx),
      batches: ctx.db.all("SELECT b.*, r.naam AS rekening FROM import_batches b LEFT JOIN bankrekeningen r ON r.id = b.rekening_id ORDER BY b.id DESC LIMIT 30"),
    });
  });

  r.post("/upload", upload.single("bestand"), csrfNaUpload, (req, res) => {
    const f = req.file;
    if (!f) throw new GebruikersFout("Kies een CSV-bestand");
    const doel: Doel = req.body.doel === "relaties" ? "relaties" : "banktransacties";
    const rekeningId = geheel(req.body.rekening_id);
    if (doel === "banktransacties" && !rekeningId) throw new GebruikersFout("Kies eerst een bankrekening (of maak er een aan onder Bank)");
    const token = bewaarUpload(ctx, f.buffer);
    const q = new URLSearchParams({ t: token, doel, naam: f.originalname.slice(0, 200) });
    if (rekeningId) q.set("rekening", String(rekeningId));
    if (tekst(req.body.profiel)) q.set("profiel", req.body.profiel);
    res.redirect(`/import/preview?${q}`);
  });

  /** Preview + mapping. Met ?aangepast=1 en mapping-velden wordt een eigen koppeling gebruikt. */
  const preview = (req: Request, res: Response, b: Record<string, unknown>) => {
    const token = String(b.t ?? "");
    const doel: Doel = b.doel === "relaties" ? "relaties" : "banktransacties";
    const rekeningId = geheel(b.rekening) ?? undefined;
    const data = leesUpload(ctx, token);
    let profiel: Profiel | null = null;
    if (b.aangepast === "1") profiel = profielUitFormulier(doel, b);
    else if (tekst(b.profiel)) profiel = vindProfiel(ctx, String(b.profiel)) ?? null;
    const analyse = analyseer(ctx, data, { doel, profiel, rekeningId });
    render(ctx, req, res, "import/preview", {
      titel: "Controleren en importeren",
      token,
      doel,
      rekeningId,
      bestandsnaam: String(b.naam ?? "import.csv"),
      analyse,
      profielen: alleProfielen(ctx, doel),
      velden: doel === "banktransacties" ? BANK_VELDEN : RELATIE_VELDEN,
      veldLabel: VELD_LABEL,
      datumformaten: DATUMFORMATEN,
      aangepast: b.aangepast === "1" || !analyse.profiel,
      mapping: b,
    });
  };

  r.get("/preview", (req, res) => preview(req, res, req.query as Record<string, unknown>));
  r.post("/preview", (req, res) => preview(req, res, req.body as Record<string, unknown>));

  r.post("/uitvoeren", (req, res) => {
    const b = req.body as Record<string, unknown>;
    const token = String(b.t ?? "");
    const doel: Doel = b.doel === "relaties" ? "relaties" : "banktransacties";
    const data = leesUpload(ctx, token);
    const profiel = b.aangepast === "1" ? profielUitFormulier(doel, b) : vindProfiel(ctx, String(b.profiel ?? ""));
    if (!profiel) throw new GebruikersFout("Kies een profiel of koppel de kolommen");
    if (b.aangepast === "1" && b.profiel_opslaan === "1" && tekst(b.profielnaam)) slaProfielOp(ctx, profiel.naam, profiel.config, gebruiker(req));
    const r_ = importeer(ctx, data, { doel, profiel, rekeningId: geheel(b.rekening) ?? undefined, bestandsnaam: String(b.naam ?? "import.csv"), gebruiker: gebruiker(req) });
    verwijderUpload(ctx, token);
    let auto = 0;
    if (doel === "banktransacties" && r_.nieuw > 0) auto = autoAfletteren(ctx, gebruiker(req));
    klaar(
      ctx,
      req,
      res,
      doel === "banktransacties" ? "/bank/afletteren" : "/relaties",
      `Import klaar: ${r_.nieuw} nieuw, ${r_.dubbel} al aanwezig, ${r_.fout} met fouten overgeslagen.${auto ? ` ${auto} automatisch afgeletterd.` : ""}`,
    );
  });

  r.post("/batches/:id/terugdraaien", (req, res) => {
    const n = draaiImportTerug(ctx, idParam(req.params.id), gebruiker(req));
    klaar(ctx, req, res, "/import", `Import teruggedraaid (${n} transacties verwijderd).`);
  });

  r.post("/profielen/:id/verwijderen", (req, res) => {
    ctx.db.run("DELETE FROM csv_profielen WHERE id = ?", [idParam(req.params.id)]);
    klaar(ctx, req, res, "/import", "Profiel verwijderd.");
  });

  return r;
}
