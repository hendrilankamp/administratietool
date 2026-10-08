import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../../lib/context.ts";
import { naarCsv } from "../../lib/csv.ts";
import { overlapFractie } from "../../lib/datum.ts";
import { bijlageBestandsnaamOpSchijf } from "../../lib/bijlagen.ts";
import { ZipSchrijver } from "../../backup/zip.ts";
import { berekenAangifte } from "../btw/service.ts";
import { factuurLijst } from "../facturen/service.ts";

export interface WvRegel {
  categorie_id: number | null;
  categorie: string;
  bedrag: number;
}

export interface WinstEnVerlies {
  van: string;
  tot: string;
  omzet: WvRegel[];
  kosten: WvRegel[];
  neutraal: WvRegel[];
  totaalOmzet: number;
  totaalKosten: number;
  resultaat: number;
}

/**
 * Winst & verlies (exclusief BTW) op basis van factuurdatum, plus banktransacties die zonder factuur op een
 * categorie zijn geboekt (bv. bankkosten, ingehouden Mollie-kosten).
 */
export function winstEnVerlies(ctx: Ctx, van: string, tot: string): WinstEnVerlies {
  const per = new Map<string, WvRegel & { soort: string }>();
  const tel = (id: number | null, naam: string | null, soort: string, bedrag: number) => {
    const k = `${soort}|${id ?? "geen"}`;
    const r = per.get(k) ?? { categorie_id: id, categorie: naam ?? "(geen categorie)", bedrag: 0, soort };
    r.bedrag += bedrag;
    per.set(k, r);
  };

  for (const r of ctx.db.all<{ categorie_id: number | null; naam: string | null; soort: string | null; bedrag: number }>(
    `SELECT r.categorie_id, c.naam, c.soort, SUM(r.bedrag_excl) AS bedrag FROM verkoopfactuur_regels r
     JOIN verkoopfacturen f ON f.id = r.factuur_id LEFT JOIN categorieen c ON c.id = r.categorie_id
     WHERE f.status = 'geboekt' AND f.factuurdatum BETWEEN ? AND ? GROUP BY r.categorie_id`,
    [van, tot],
  )) {
    tel(r.categorie_id, r.naam, r.soort === "neutraal" ? "neutraal" : r.soort === "kosten" ? "kosten" : "omzet", r.soort === "kosten" ? -r.bedrag : r.bedrag);
  }
  for (const r of ctx.db.all<{ categorie_id: number | null; naam: string | null; soort: string | null; bedrag: number }>(
    `SELECT r.categorie_id, c.naam, c.soort, SUM(r.bedrag_excl) AS bedrag FROM inkoopfactuur_regels r
     JOIN inkoopfacturen f ON f.id = r.factuur_id LEFT JOIN categorieen c ON c.id = r.categorie_id
     WHERE f.status = 'geboekt' AND f.factuurdatum BETWEEN ? AND ? GROUP BY r.categorie_id`,
    [van, tot],
  )) {
    tel(r.categorie_id, r.naam, r.soort === "neutraal" ? "neutraal" : r.soort === "omzet" ? "omzet" : "kosten", r.soort === "omzet" ? -r.bedrag : r.bedrag);
  }
  // Bankboekingen zonder factuur: restant = bedrag - gekoppeld
  for (const r of ctx.db.all<{ categorie_id: number; naam: string; soort: string; rest: number }>(
    `SELECT t.categorie_id, c.naam, c.soort, SUM(t.bedrag - COALESCE((SELECT SUM(k.bedrag) FROM transactie_koppelingen k WHERE k.transactie_id = t.id), 0)) AS rest
     FROM banktransacties t JOIN categorieen c ON c.id = t.categorie_id
     WHERE t.categorie_id IS NOT NULL AND t.boekdatum BETWEEN ? AND ? GROUP BY t.categorie_id`,
    [van, tot],
  )) {
    if (r.rest === 0) continue;
    if (r.soort === "kosten") tel(r.categorie_id, r.naam, "kosten", -r.rest);
    else if (r.soort === "omzet") tel(r.categorie_id, r.naam, "omzet", r.rest);
    else tel(r.categorie_id, r.naam, "neutraal", r.rest);
  }

  const lijst = (soort: string) => [...per.values()].filter((r) => r.soort === soort && r.bedrag !== 0).sort((a, b) => b.bedrag - a.bedrag).map(({ soort: _, ...r }) => r);
  const omzet = lijst("omzet");
  const kosten = lijst("kosten");
  const totaalOmzet = omzet.reduce((s, r) => s + r.bedrag, 0);
  const totaalKosten = kosten.reduce((s, r) => s + r.bedrag, 0);
  return { van, tot, omzet, kosten, neutraal: lijst("neutraal"), totaalOmzet, totaalKosten, resultaat: totaalOmzet - totaalKosten };
}

export interface DashboardCijfers {
  omzetKwartaal: number;
  kostenKwartaal: number;
  teBeoordelen: number;
  aiFouten: number;
  openTransacties: number;
  debiteuren: number;
  debiteurenAantal: number;
  crediteuren: number;
  crediteurenAantal: number;
  vervallenCrediteuren: number;
  btwKwartaal: number;
  banksaldo: { naam: string; saldo: number; laatsteDatum: string | null }[];
  mailZonderBijlage: number;
}

export function dashboardCijfers(ctx: Ctx, jaar: number, kwartaal: number, vandaag: string): DashboardCijfers {
  const a = berekenAangifte(ctx.db, jaar, kwartaal);
  const wv = winstEnVerlies(ctx, a.van, a.tot);
  const deb = factuurLijst(ctx, "verkoop", { status: "geboekt", betaalstatus: "onbetaald", limiet: 10000 });
  const cred = factuurLijst(ctx, "inkoop", { status: "geboekt", betaalstatus: "onbetaald", limiet: 10000 });
  const n = (sql: string, p: (string | number)[] = []) => ctx.db.get<{ n: number }>(sql, p)!.n;
  return {
    omzetKwartaal: wv.totaalOmzet,
    kostenKwartaal: wv.totaalKosten,
    teBeoordelen: n("SELECT COUNT(*) AS n FROM inkoopfacturen WHERE status = 'te_beoordelen'"),
    aiFouten: n("SELECT COUNT(*) AS n FROM inkoopfacturen WHERE status = 'te_beoordelen' AND ai_status = 'fout'"),
    openTransacties: n("SELECT COUNT(*) AS n FROM banktransacties WHERE status = 'open'"),
    debiteuren: deb.reduce((s, f) => s + f.openstaand, 0),
    debiteurenAantal: deb.length,
    crediteuren: cred.reduce((s, f) => s + f.openstaand, 0),
    crediteurenAantal: cred.length,
    vervallenCrediteuren: cred.filter((f) => f.vervaldatum && f.vervaldatum < vandaag).length,
    btwKwartaal: a.saldo,
    banksaldo: ctx.db.all<{ naam: string; saldo: number; laatsteDatum: string | null }>(
      `SELECT r.naam, r.beginsaldo + COALESCE((SELECT SUM(bedrag) FROM banktransacties t WHERE t.rekening_id = r.id AND t.boekdatum > r.begindatum), 0) AS saldo,
              (SELECT MAX(boekdatum) FROM banktransacties t WHERE t.rekening_id = r.id) AS laatsteDatum
       FROM bankrekeningen r ORDER BY r.naam`,
    ),
    mailZonderBijlage: n("SELECT COUNT(*) AS n FROM email_berichten WHERE aantal_bijlagen = 0 AND verwerkt_op >= ?", [new Date(Date.now() - 30 * 86400000).toISOString()]),
  };
}

/** Maakt een zip voor de accountant met CSV-overzichten van een jaar en alle bijbehorende PDF's. */
export async function exportAccountant(ctx: Ctx, jaar: number): Promise<string> {
  const van = `${jaar}-01-01`;
  const tot = `${jaar}-12-31`;
  fs.mkdirSync(path.join(ctx.config.dataDir, "tmp"), { recursive: true, mode: 0o700 });
  const pad = path.join(fs.mkdtempSync(path.join(ctx.config.dataDir, "tmp", "export-")), `medialan-boekhouding-${jaar}.zip`);
  const zip = new ZipSchrijver(pad);
  const q = (sql: string) => ctx.db.all<Record<string, unknown>>(sql, [van, tot]);
  const csv = (naam: string, rijen: Record<string, unknown>[]) => zip.voegToe(naam, naarCsv(rijen.length ? Object.keys(rijen[0]) : ["leeg"], rijen));
  const euro = (kolom: string) => `printf('%.2f', ${kolom} / 100.0) AS ${kolom.replace(/^.*\./, "")}`;

  csv(
    "verkoopfacturen.csv",
    q(`SELECT f.id, f.factuurnummer, f.factuurdatum, f.vervaldatum, r.naam AS klant, r.btw_nummer, ${euro("f.totaal_excl")}, ${euro("f.totaal_btw")}, ${euro("f.totaal_incl")},
              f.status, f.bron, f.mollie_status, f.mollie_betaald_op, f.betaald_handmatig_op, f.bijlage_sha256
       FROM verkoopfacturen f LEFT JOIN relaties r ON r.id = f.relatie_id WHERE f.status <> 'concept' AND f.factuurdatum BETWEEN ? AND ? ORDER BY f.factuurdatum, f.id`),
  );
  csv(
    "verkoopfactuur_regels.csv",
    q(`SELECT f.factuurnummer, f.factuurdatum, rg.omschrijving, c.naam AS categorie, rg.btw_code, ${euro("rg.bedrag_excl")}, ${euro("rg.btw_bedrag")}
       FROM verkoopfactuur_regels rg JOIN verkoopfacturen f ON f.id = rg.factuur_id LEFT JOIN categorieen c ON c.id = rg.categorie_id
       WHERE f.status = 'geboekt' AND f.factuurdatum BETWEEN ? AND ? ORDER BY f.factuurdatum, f.id, rg.volgorde`),
  );
  csv(
    "inkoopfacturen.csv",
    q(`SELECT f.id, f.factuurnummer, f.factuurdatum, f.vervaldatum, r.naam AS leverancier, r.btw_nummer, ${euro("f.totaal_excl")}, ${euro("f.totaal_btw")}, ${euro("f.totaal_incl")},
              f.status, f.bron, f.betaald_handmatig_op, f.bijlage_sha256
       FROM inkoopfacturen f LEFT JOIN relaties r ON r.id = f.relatie_id WHERE f.status = 'geboekt' AND f.factuurdatum BETWEEN ? AND ? ORDER BY f.factuurdatum, f.id`),
  );
  csv(
    "inkoopfactuur_regels.csv",
    q(`SELECT f.factuurnummer, f.factuurdatum, r.naam AS leverancier, rg.omschrijving, c.naam AS categorie, rg.btw_code, ${euro("rg.bedrag_excl")}, ${euro("rg.btw_bedrag")}
       FROM inkoopfactuur_regels rg JOIN inkoopfacturen f ON f.id = rg.factuur_id LEFT JOIN categorieen c ON c.id = rg.categorie_id LEFT JOIN relaties r ON r.id = f.relatie_id
       WHERE f.status = 'geboekt' AND f.factuurdatum BETWEEN ? AND ? ORDER BY f.factuurdatum, f.id, rg.volgorde`),
  );
  csv(
    "banktransacties.csv",
    q(`SELECT t.id, b.naam AS rekening, t.boekdatum, ${euro("t.bedrag")}, t.tegenpartij_naam, t.tegenpartij_iban, t.omschrijving, t.status, c.naam AS categorie_zonder_factuur,
              (SELECT group_concat(COALESCE('V:' || v.factuurnummer, 'I:' || i.factuurnummer), ', ') FROM transactie_koppelingen k
                 LEFT JOIN verkoopfacturen v ON v.id = k.verkoopfactuur_id LEFT JOIN inkoopfacturen i ON i.id = k.inkoopfactuur_id WHERE k.transactie_id = t.id) AS gekoppelde_facturen
       FROM banktransacties t JOIN bankrekeningen b ON b.id = t.rekening_id LEFT JOIN categorieen c ON c.id = t.categorie_id
       WHERE t.boekdatum BETWEEN ? AND ? ORDER BY t.boekdatum, t.id`),
  );
  csv("relaties.csv", ctx.db.all("SELECT id, naam, type, kvk, btw_nummer, iban, email, adres, postcode, plaats, land FROM relaties ORDER BY naam"));

  const wv = winstEnVerlies(ctx, van, tot);
  csv("winst_en_verlies.csv", [
    ...wv.omzet.map((r) => ({ soort: "omzet", categorie: r.categorie, bedrag: (r.bedrag / 100).toFixed(2) })),
    ...wv.kosten.map((r) => ({ soort: "kosten", categorie: r.categorie, bedrag: (r.bedrag / 100).toFixed(2) })),
    { soort: "resultaat", categorie: "Resultaat", bedrag: (wv.resultaat / 100).toFixed(2) },
  ]);
  const btw: Record<string, unknown>[] = [];
  for (let k = 1; k <= 4; k++) {
    const a = berekenAangifte(ctx.db, jaar, k);
    for (const r of a.aangifteEuros) btw.push({ kwartaal: `${jaar}-Q${k}`, status: a.periode.status, rubriek: r.rubriek, grondslag_eur: r.grondslag ?? "", btw_eur: r.btw });
  }
  csv("btw_per_kwartaal.csv", btw);

  const bijlagen = ctx.db.all<{ sha256: string; mime: string }>(
    `SELECT DISTINCT b.sha256, b.mime FROM bijlagen b WHERE b.sha256 IN (
       SELECT bijlage_sha256 FROM inkoopfacturen WHERE status = 'geboekt' AND factuurdatum BETWEEN ? AND ?
       UNION SELECT bijlage_sha256 FROM verkoopfacturen WHERE status = 'geboekt' AND factuurdatum BETWEEN ? AND ?)`,
    [van, tot, van, tot],
  );
  for (const b of bijlagen) {
    const naam = bijlageBestandsnaamOpSchijf(b.sha256, b.mime);
    const p = path.join(ctx.config.bijlagenDir, naam);
    if (fs.existsSync(p)) zip.voegToe(`facturen/${naam}`, fs.readFileSync(p), false);
  }
  zip.voegToe("LEESMIJ.txt", `Export boekhouding Medialan ${jaar}.\nBedragen in euro's, exclusief/inclusief BTW zoals aangegeven. PDF's in facturen/ zijn genoemd naar de kolom bijlage_sha256.\n`);
  await zip.sluit();
  return pad;
}

export interface DoorbelastingKlant {
  relatie_id: number;
  naam: string;
  ingekocht: number; // excl. BTW, centen (naar rato over de periode)
  verkocht: number; // excl. BTW, centen (naar rato over de periode)
  verschil: number; // verkocht - ingekocht
  regels: { factuur_id: number; factuurnummer: string | null; leverancier: string | null; factuurdatum: string | null; omschrijving: string | null; periode_van: string | null; periode_tot: string | null; bedrag_excl: number; aandeel: number; deel: number }[];
  verkoop: { factuur_id: number; factuurnummer: string | null; factuurdatum: string | null; omschrijving: string | null; periode_van: string | null; periode_tot: string | null; bedrag_excl: number; aandeel: number; deel: number }[];
}

/** Deel van een regel dat in [van, tot] valt: naar rato van de regelperiode, anders op factuurdatum. */
function aandeel(van: string, tot: string, r: { periode_van: string | null; periode_tot: string | null; factuurdatum: string | null }): number {
  if (r.periode_van && r.periode_tot) return overlapFractie(van, tot, r.periode_van, r.periode_tot);
  return r.factuurdatum && r.factuurdatum >= van && r.factuurdatum <= tot ? 1 : 0;
}

/** Regels met een periode die [van, tot] overlapt, of zonder periode met factuurdatum in [van, tot]. */
const OVERLAP = "((r.periode_van IS NOT NULL AND r.periode_van <= ? AND r.periode_tot >= ?) OR (r.periode_van IS NULL AND f.factuurdatum BETWEEN ? AND ?))";

/**
 * Doorbelasting per klant: wat er voor een klant is ingekocht (inkoopregels met "doorbelasten aan") tegenover wat er
 * aan die klant is gefactureerd. Regels met een periode (bv. een jaarfactuur) worden naar rato over die periode verdeeld,
 * zodat een jaarlijkse verkoopfactuur eerlijk tegenover maandelijkse inkoop staat.
 */
export function doorbelastingPerKlant(ctx: Ctx, van: string, tot: string): { klanten: DoorbelastingKlant[]; nietToegewezen: { naam: string; bedrag: number; aantal: number }[] } {
  const p = [tot, van, van, tot];
  const inkoop = ctx.db.all<Omit<DoorbelastingKlant["regels"][number], "aandeel" | "deel"> & { relatie_id: number; klant: string }>(
    `SELECT r.doorbelast_relatie_id AS relatie_id, k.naam AS klant, f.id AS factuur_id, f.factuurnummer, l.naam AS leverancier, f.factuurdatum,
            r.omschrijving, r.periode_van, r.periode_tot, r.bedrag_excl
     FROM inkoopfactuur_regels r JOIN inkoopfacturen f ON f.id = r.factuur_id
     JOIN relaties k ON k.id = r.doorbelast_relatie_id LEFT JOIN relaties l ON l.id = f.relatie_id
     WHERE f.status = 'geboekt' AND ${OVERLAP}
     ORDER BY k.naam, f.factuurdatum`,
    p,
  );
  const perKlant = new Map<number, DoorbelastingKlant>();
  for (const r of inkoop) {
    const k = perKlant.get(r.relatie_id) ?? { relatie_id: r.relatie_id, naam: r.klant, ingekocht: 0, verkocht: 0, verschil: 0, regels: [], verkoop: [] };
    const a = aandeel(van, tot, r);
    const deel = Math.round(r.bedrag_excl * a);
    k.ingekocht += deel;
    k.regels.push({ ...r, aandeel: a, deel });
    perKlant.set(r.relatie_id, k);
  }
  for (const k of perKlant.values()) {
    const verkoop = ctx.db.all<Omit<DoorbelastingKlant["verkoop"][number], "aandeel" | "deel">>(
      `SELECT f.id AS factuur_id, f.factuurnummer, f.factuurdatum, r.omschrijving, r.periode_van, r.periode_tot, r.bedrag_excl
       FROM verkoopfactuur_regels r JOIN verkoopfacturen f ON f.id = r.factuur_id
       WHERE f.relatie_id = ? AND f.status = 'geboekt' AND ${OVERLAP} ORDER BY f.factuurdatum, r.volgorde`,
      [k.relatie_id, ...p],
    );
    k.verkoop = verkoop.map((r) => {
      const a = aandeel(van, tot, r);
      return { ...r, aandeel: a, deel: Math.round(r.bedrag_excl * a) };
    });
    k.verkocht = k.verkoop.reduce((s, r) => s + r.deel, 0);
    k.verschil = k.verkocht - k.ingekocht;
  }
  const nietToegewezen = ctx.db.all<{ naam: string; bedrag: number; aantal: number }>(
    `SELECT r.doorbelast_naam AS naam, SUM(r.bedrag_excl) AS bedrag, COUNT(*) AS aantal
     FROM inkoopfactuur_regels r JOIN inkoopfacturen f ON f.id = r.factuur_id
     WHERE r.doorbelast_naam IS NOT NULL AND r.doorbelast_relatie_id IS NULL AND (f.status = 'te_beoordelen' OR f.factuurdatum BETWEEN ? AND ?)
     GROUP BY r.doorbelast_naam ORDER BY r.doorbelast_naam`,
    [van, tot],
  );
  return { klanten: [...perKlant.values()].sort((a, b) => a.verschil - b.verschil), nietToegewezen };
}

export interface MargeAlarm {
  relatie_id: number;
  naam: string;
  ingekocht: number;
  verkocht: number;
  marge: number | null; // percentage; null = geen verkoop
}

/**
 * Marge-alarm: klanten waarbij de doorbelaste inkoop tegenover de verkoop minder dan MARGE_MIN % marge oplevert,
 * gemeten over de laatste MARGE_MAANDEN volledige maanden. Door de verdeling naar rato staat een jaarfactuur
 * eerlijk tegenover maandelijkse inkoop; regels hoeven niet één-op-één overeen te komen (totaal per klant).
 */
export function margeAlarmen(ctx: Ctx, nu: Date = new Date()): { van: string; tot: string; minimum: number; alarmen: MargeAlarm[] } {
  const maanden = ctx.config.MARGE_MAANDEN;
  const eindeVorigeMaand = new Date(Date.UTC(nu.getFullYear(), nu.getMonth(), 0));
  const begin = new Date(Date.UTC(nu.getFullYear(), nu.getMonth() - maanden, 1));
  const van = begin.toISOString().slice(0, 10);
  const tot = eindeVorigeMaand.toISOString().slice(0, 10);
  const minimum = ctx.config.MARGE_MIN;
  const alarmen = doorbelastingPerKlant(ctx, van, tot)
    .klanten.filter((k) => k.ingekocht > 0)
    .map((k) => ({ relatie_id: k.relatie_id, naam: k.naam, ingekocht: k.ingekocht, verkocht: k.verkocht, marge: k.verkocht > 0 ? ((k.verkocht - k.ingekocht) / k.verkocht) * 100 : null }))
    .filter((k) => k.marge === null || k.marge < minimum)
    .sort((a, b) => (a.marge ?? -Infinity) - (b.marge ?? -Infinity));
  return { van, tot, minimum, alarmen };
}
