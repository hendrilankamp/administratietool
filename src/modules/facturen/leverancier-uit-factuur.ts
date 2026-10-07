import type { Ctx } from "../../lib/context.ts";
import { audit } from "../../lib/context.ts";
import type { AiVoorstel } from "../../integrations/ai/extract.ts";
import { categorieen, haalRelatie, normaliseerBtwNummer, normaliseerIban, zoekRelatieMatch, type Relatie } from "../relaties/service.ts";

/** Velden van een relatie die uit een factuur kunnen komen. */
export const AANVULBAAR = ["btw_nummer", "kvk", "iban", "email", "adres", "postcode", "plaats"] as const;
type Aanvulbaar = (typeof AANVULBAAR)[number];

export const VELD_NAAM: Record<Aanvulbaar, string> = {
  btw_nummer: "BTW-nummer",
  kvk: "KvK-nummer",
  iban: "IBAN",
  email: "e-mail",
  adres: "adres",
  postcode: "postcode",
  plaats: "plaats",
};

const schoon = (s: string | null | undefined, max: number) => {
  const t = (s ?? "").trim();
  return t ? t.slice(0, max) : null;
};

/** Zet de leveranciersgegevens uit een AI-voorstel om naar (gevalideerbare) relatievelden. */
export function leverancierVelden(
  ctx: Ctx,
  v: AiVoorstel,
  regels: { categorie_id: number | null; btw_code: string }[] = [],
): Record<string, string | number | null> & { naam: string; type: "leverancier" } {
  const l = v.leverancier;
  const email = schoon(l.email, 200);
  const land = schoon(l.land, 2)?.toUpperCase() ?? (l.btw_nummer ? normaliseerBtwNummer(l.btw_nummer).slice(0, 2) : null);
  const kvk = (l.kvk ?? "").replace(/\D/g, "");
  const iban = l.iban ? normaliseerIban(l.iban) : "";
  const btwCodes = [...new Set(regels.map((r) => r.btw_code))];
  return {
    naam: (schoon(l.naam, 200) ?? "Onbekende leverancier") as string,
    type: "leverancier",
    btw_nummer: l.btw_nummer ? normaliseerBtwNummer(l.btw_nummer).slice(0, 20) : null,
    kvk: kvk.length >= 6 && kvk.length <= 12 ? kvk : null,
    iban: /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(iban) ? iban : null,
    email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    adres: schoon(l.adres, 200),
    postcode: schoon(l.postcode, 20),
    plaats: schoon(l.plaats, 100),
    land: land && /^[A-Z]{2}$/.test(land) ? land : "NL",
    standaard_categorie_id: regels.find((r) => r.categorie_id)?.categorie_id ?? categorieen(ctx).find((c) => c.naam === v.voorgestelde_categorie)?.id ?? null,
    // Alleen een vaste BTW-code onthouden als alle regels dezelfde (bijzondere) code hebben, bv. EU-dienst
    standaard_btw_code: btwCodes.length === 1 && !["NL21", "NL9"].includes(btwCodes[0]) ? btwCodes[0] : null,
  };
}

/** Velden die in de bestaande relatie leeg zijn maar wel op de factuur staan. */
export function aanvullingen(ctx: Ctx, relatie: Relatie, v: AiVoorstel): Partial<Record<Aanvulbaar, string>> {
  const nieuw = leverancierVelden(ctx, v);
  const uit: Partial<Record<Aanvulbaar, string>> = {};
  for (const k of AANVULBAAR) {
    const waarde = nieuw[k];
    if (!relatie[k] && typeof waarde === "string" && waarde) uit[k] = waarde;
  }
  return uit;
}

/** Vult lege velden van een relatie aan met gegevens van de factuur (overschrijft nooit iets). */
export function vulLeverancierAan(ctx: Ctx, relatieId: number, v: AiVoorstel, gebruiker: string): string[] {
  const rel = haalRelatie(ctx, relatieId);
  if (!rel) return [];
  const a = aanvullingen(ctx, rel, v);
  const velden = Object.keys(a) as Aanvulbaar[];
  if (!velden.length) return [];
  ctx.db.tx(() => {
    for (const k of velden) ctx.db.run(`UPDATE relaties SET ${k} = ?, gewijzigd_op = ? WHERE id = ? AND (${k} IS NULL OR ${k} = '')`, [a[k]!, new Date().toISOString(), relatieId]);
    audit(ctx.db, gebruiker, "aangevuld_uit_factuur", "relaties", relatieId, a);
  });
  return velden.map((k) => VELD_NAAM[k]);
}

/** AI-meldingen die niet meer gelden zodra er een leverancier gekoppeld is. */
export function actueleMeldingen(melding: string | null | undefined, heeftLeverancier: boolean): string[] {
  return (melding ?? "")
    .split("\n")
    .map((m) => m.trim())
    .filter(Boolean)
    .filter((m) => !(heeftLeverancier && /^Leverancier ".*" is nog niet bekend/.test(m)));
}

/** Koppelt een leverancier aan een factuur en vult ontbrekende categorieën op de regels in. */
export function koppelLeverancierAanFactuur(ctx: Ctx, factuurId: number, relatieId: number): void {
  const rel = haalRelatie(ctx, relatieId);
  if (!rel) return;
  ctx.db.tx(() => {
    ctx.db.run("UPDATE inkoopfacturen SET relatie_id = ?, gewijzigd_op = ? WHERE id = ? AND status = 'te_beoordelen'", [relatieId, new Date().toISOString(), factuurId]);
    // Melding "leverancier nog niet bekend" opruimen
    const m = ctx.db.get<{ ai_melding: string | null }>("SELECT ai_melding FROM inkoopfacturen WHERE id = ?", [factuurId])?.ai_melding;
    if (m) ctx.db.run("UPDATE inkoopfacturen SET ai_melding = ? WHERE id = ?", [actueleMeldingen(m, true).join("\n") || null, factuurId]);
    if (rel.standaard_categorie_id) {
      ctx.db.run(
        "UPDATE inkoopfactuur_regels SET categorie_id = ? WHERE factuur_id = ? AND categorie_id IS NULL AND (SELECT status FROM inkoopfacturen WHERE id = ?) = 'te_beoordelen'",
        [rel.standaard_categorie_id, factuurId, factuurId],
      );
    }
  });
}

/** Koppelt te beoordelen facturen zonder leverancier aan een (inmiddels) bekende relatie. */
export function koppelOnbekendeLeveranciers(ctx: Ctx): number {
  let n = 0;
  const rijen = ctx.db.all<{ id: number; ai_voorstel: string }>(
    "SELECT id, ai_voorstel FROM inkoopfacturen WHERE status = 'te_beoordelen' AND relatie_id IS NULL AND ai_voorstel IS NOT NULL",
  );
  for (const r of rijen) {
    try {
      const l = (JSON.parse(r.ai_voorstel) as AiVoorstel).leverancier;
      const rel = zoekRelatieMatch(ctx, { btw_nummer: l.btw_nummer, iban: l.iban, naam: l.naam });
      if (rel) {
        koppelLeverancierAanFactuur(ctx, r.id, rel.id);
        n++;
      }
    } catch {
      // ongeldig voorstel: overslaan
    }
  }
  return n;
}
