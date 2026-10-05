import type { Db } from "../../db/index.ts";
import { GebruikersFout } from "../../lib/context.ts";
import { kwartaalGrenzen, kwartaalVan } from "../../lib/datum.ts";
import { berekenBtw, heleEurosOmlaag } from "../../lib/geld.ts";

export interface BtwCode {
  code: string;
  omschrijving: string;
  tarief_bp: number;
  soort: "verkoop" | "inkoop" | "beide";
  rubriek_verkoop: string | null;
  rubriek_inkoop: string | null;
  verlegd: number;
}

export function btwCodes(db: Db): BtwCode[] {
  return db.all<BtwCode>("SELECT * FROM btw_codes ORDER BY volgorde, code");
}

export function btwCodeMap(db: Db): Map<string, BtwCode> {
  return new Map(btwCodes(db).map((c) => [c.code, c]));
}

/**
 * BTW-bedrag zoals het op de factuur staat. Bij verlegde BTW staat er geen BTW op de factuur (0).
 * Als `opgegeven` is meegegeven (bv. van de factuur overgenomen) en het verschil met de berekening klein is,
 * wordt het opgegeven bedrag gebruikt (afrondingsverschillen per factuur i.p.v. per regel).
 */
export function regelBtw(code: BtwCode, bedragExcl: number, opgegeven?: number | null): number {
  if (code.verlegd || code.tarief_bp === 0) return 0;
  const berekend = berekenBtw(bedragExcl, code.tarief_bp);
  if (opgegeven === null || opgegeven === undefined) return berekend;
  return opgegeven;
}

/** Verschil tussen opgegeven en berekende BTW, voor waarschuwingen. */
export function btwAfwijking(code: BtwCode, bedragExcl: number, btwBedrag: number): number {
  if (code.verlegd || code.tarief_bp === 0) return btwBedrag;
  return btwBedrag - berekenBtw(bedragExcl, code.tarief_bp);
}

// ---------- Perioden ----------

export interface Periode {
  id: string;
  jaar: number;
  kwartaal: number;
  status: "open" | "afgesloten";
  afgesloten_op: string | null;
  correctie_1d_grondslag: number;
  correctie_1d_btw: number;
  notitie: string | null;
}

export function zorgVoorPeriode(db: Db, jaar: number, kwartaal: number): Periode {
  const id = `${jaar}-Q${kwartaal}`;
  db.run("INSERT OR IGNORE INTO perioden (id, jaar, kwartaal) VALUES (?, ?, ?)", [id, jaar, kwartaal]);
  return db.get<Periode>("SELECT * FROM perioden WHERE id = ?", [id])!;
}

export function isAfgesloten(db: Db, datum: string | null | undefined): boolean {
  if (!datum) return false;
  const { id } = kwartaalVan(datum);
  return db.get<{ status: string }>("SELECT status FROM perioden WHERE id = ?", [id])?.status === "afgesloten";
}

export function eisOpenPeriode(db: Db, ...datums: (string | null | undefined)[]): void {
  for (const d of datums) {
    if (isAfgesloten(db, d)) {
      throw new GebruikersFout(`De periode ${kwartaalVan(d!).id} is afgesloten (BTW-aangifte ingediend). Wijzigen kan niet meer; gebruik een creditfactuur in een open periode.`);
    }
  }
}

// ---------- Aangifte ----------

export const RUBRIEKEN = ["1a", "1b", "1c", "1d", "1e", "2a", "3a", "3b", "3c", "4a", "4b"] as const;
export type Rubriek = (typeof RUBRIEKEN)[number];

export const RUBRIEK_OMSCHRIJVING: Record<Rubriek, string> = {
  "1a": "Leveringen/diensten belast met hoog tarief",
  "1b": "Leveringen/diensten belast met laag tarief",
  "1c": "Leveringen/diensten belast met overige tarieven",
  "1d": "Privégebruik",
  "1e": "Leveringen/diensten belast met 0% of niet bij u belast",
  "2a": "Leveringen/diensten waarbij de heffing van omzetbelasting naar u is verlegd",
  "3a": "Leveringen naar landen buiten de EU (uitvoer)",
  "3b": "Leveringen naar of diensten in landen binnen de EU",
  "3c": "Installatie/afstandsverkopen binnen de EU",
  "4a": "Leveringen/diensten uit landen buiten de EU",
  "4b": "Leveringen/diensten uit landen binnen de EU",
};

export interface AangifteRegel {
  rubriek: Rubriek;
  omschrijving: string;
  grondslag: number; // centen
  btw: number; // centen
}

export interface Aangifte {
  periode: Periode;
  van: string;
  tot: string;
  regels: AangifteRegel[];
  verschuldigd: number; // 5a (centen)
  voorbelasting: number; // 5b (centen)
  saldo: number; // 5c (centen), positief = betalen
  aangifteEuros: { rubriek: string; grondslag: number | null; btw: number }[];
  teBetalenEuros: number;
  aantalFacturen: { verkoop: number; inkoop: number };
  waarschuwingen: string[];
}

interface RegelRij {
  bedrag_excl: number;
  btw_bedrag: number;
  btw_code: string;
}

export function berekenAangifte(db: Db, jaar: number, kwartaal: number): Aangifte {
  const periode = zorgVoorPeriode(db, jaar, kwartaal);
  const { van, tot } = kwartaalGrenzen(jaar, kwartaal);
  const codes = btwCodeMap(db);
  const tot_: Record<Rubriek, { grondslag: number; btw: number }> = Object.fromEntries(
    RUBRIEKEN.map((r) => [r, { grondslag: 0, btw: 0 }]),
  ) as Record<Rubriek, { grondslag: number; btw: number }>;
  let voorbelasting = 0;

  const verkoop = db.all<RegelRij>(
    `SELECT r.bedrag_excl, r.btw_bedrag, r.btw_code FROM verkoopfactuur_regels r
     JOIN verkoopfacturen f ON f.id = r.factuur_id
     WHERE f.status = 'geboekt' AND f.factuurdatum BETWEEN ? AND ?`,
    [van, tot],
  );
  for (const r of verkoop) {
    const c = codes.get(r.btw_code);
    const rub = c?.rubriek_verkoop as Rubriek | null | undefined;
    if (!c || !rub) continue;
    tot_[rub].grondslag += r.bedrag_excl;
    if (rub === "1a" || rub === "1b" || rub === "1c") tot_[rub].btw += r.btw_bedrag;
  }

  const inkoop = db.all<RegelRij>(
    `SELECT r.bedrag_excl, r.btw_bedrag, r.btw_code FROM inkoopfactuur_regels r
     JOIN inkoopfacturen f ON f.id = r.factuur_id
     WHERE f.status = 'geboekt' AND f.factuurdatum BETWEEN ? AND ?`,
    [van, tot],
  );
  for (const r of inkoop) {
    const c = codes.get(r.btw_code);
    if (!c || !c.rubriek_inkoop) continue;
    if (c.rubriek_inkoop === "5b") {
      voorbelasting += r.btw_bedrag;
    } else {
      const rub = c.rubriek_inkoop as Rubriek;
      const verlegdeBtw = berekenBtw(r.bedrag_excl, c.tarief_bp);
      tot_[rub].grondslag += r.bedrag_excl;
      tot_[rub].btw += verlegdeBtw;
      voorbelasting += verlegdeBtw; // verlegde BTW is (bij volledig belaste omzet) direct aftrekbaar
    }
  }

  tot_["1d"].grondslag += periode.correctie_1d_grondslag;
  tot_["1d"].btw += periode.correctie_1d_btw;

  const regels: AangifteRegel[] = RUBRIEKEN.map((r) => ({ rubriek: r, omschrijving: RUBRIEK_OMSCHRIJVING[r], ...tot_[r] }));
  const verschuldigd = regels.reduce((s, r) => s + r.btw, 0);

  // In de aangifte: hele euro's, in uw voordeel afgerond (grondslag en verschuldigd omlaag, voorbelasting omhoog).
  const metBtw = new Set(["1a", "1b", "1c", "1d", "2a", "4a", "4b"]);
  const aangifteEuros = regels.map((r) => ({
    rubriek: r.rubriek,
    grondslag: heleEurosOmlaag(r.grondslag),
    btw: metBtw.has(r.rubriek) ? heleEurosOmlaag(r.btw) : 0,
  }));
  const verschuldigdEuros = aangifteEuros.reduce((s, r) => s + r.btw, 0);
  const voorbelastingEuros = Math.sign(voorbelasting) * Math.ceil(Math.abs(voorbelasting) / 100);

  const waarschuwingen: string[] = [];
  const teBeoordelen = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM inkoopfacturen WHERE status = 'te_beoordelen' AND (factuurdatum IS NULL OR factuurdatum BETWEEN ? AND ?)",
    [van, tot],
  )!.n;
  if (teBeoordelen > 0) waarschuwingen.push(`${teBeoordelen} inkoopfactuur/-facturen staan nog op "te beoordelen".`);
  const openTx = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM banktransacties WHERE status = 'open' AND boekdatum BETWEEN ? AND ?",
    [van, tot],
  )!.n;
  if (openTx > 0) waarschuwingen.push(`${openTx} banktransactie(s) in dit kwartaal zijn nog niet afgeletterd.`);

  return {
    periode,
    van,
    tot,
    regels,
    verschuldigd,
    voorbelasting,
    saldo: verschuldigd - voorbelasting,
    aangifteEuros: [
      ...aangifteEuros,
      { rubriek: "5a", grondslag: null, btw: verschuldigdEuros },
      { rubriek: "5b", grondslag: null, btw: voorbelastingEuros },
      { rubriek: "5c", grondslag: null, btw: verschuldigdEuros - voorbelastingEuros },
    ],
    teBetalenEuros: verschuldigdEuros - voorbelastingEuros,
    aantalFacturen: {
      verkoop: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM verkoopfacturen WHERE status='geboekt' AND factuurdatum BETWEEN ? AND ?", [van, tot])!.n,
      inkoop: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM inkoopfacturen WHERE status='geboekt' AND factuurdatum BETWEEN ? AND ?", [van, tot])!.n,
    },
    waarschuwingen,
  };
}

export function sluitPeriode(db: Db, id: string): void {
  const r = db.run("UPDATE perioden SET status = 'afgesloten', afgesloten_op = ? WHERE id = ? AND status = 'open'", [new Date().toISOString(), id]);
  if (r.changes === 0) throw new GebruikersFout("Periode niet gevonden of al afgesloten");
}

export function heropenPeriode(db: Db, id: string): void {
  const r = db.run("UPDATE perioden SET status = 'open', afgesloten_op = NULL WHERE id = ? AND status = 'afgesloten'", [id]);
  if (r.changes === 0) throw new GebruikersFout("Periode niet gevonden of niet afgesloten");
}
