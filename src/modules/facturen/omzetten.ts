import type { Ctx } from "../../lib/context.ts";
import { audit, GebruikersFout } from "../../lib/context.ts";
import { isGeldigeDatum } from "../../lib/datum.ts";
import { kiesBtwCode, type AiVoorstel } from "../../integrations/ai/extract.ts";
import { categorieen, normaliseerBtwNummer, slaRelatieOp, zoekRelatieMatch } from "../relaties/service.ts";
import { haalFactuur, verwerkRegels } from "./service.ts";

export interface OmzetResultaat {
  /** ID van de nieuwe verkoopfactuur (concept), of van de bestaande als die er al was. */
  verkoopId: number;
  bestondAl: boolean;
  klantAangemaakt: string | null;
}

/** Zoekt of maakt de klant op basis van de geadresseerde op de factuur. */
function klantVoorOntvanger(ctx: Ctx, o: NonNullable<AiVoorstel["ontvanger"]>, gebruiker: string): { id: number; nieuw: boolean } {
  const bestaand = zoekRelatieMatch(ctx, { btw_nummer: o.btw_nummer, naam: o.naam });
  if (bestaand) {
    if (bestaand.type === "leverancier") ctx.db.run("UPDATE relaties SET type = 'beide' WHERE id = ?", [bestaand.id]);
    return { id: bestaand.id, nieuw: false };
  }
  const email = o.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email.trim()) ? o.email.trim() : null;
  const land = (o.land ?? "").trim().toUpperCase();
  const kvk = (o.kvk ?? "").replace(/\D/g, "");
  const id = slaRelatieOp(
    ctx,
    null,
    {
      naam: o.naam.trim().slice(0, 200),
      type: "klant",
      btw_nummer: o.btw_nummer ? normaliseerBtwNummer(o.btw_nummer).slice(0, 20) : null,
      kvk: kvk.length >= 6 && kvk.length <= 12 ? kvk : null,
      email,
      adres: o.adres?.slice(0, 200) ?? null,
      postcode: o.postcode?.slice(0, 20) ?? null,
      plaats: o.plaats?.slice(0, 100) ?? null,
      land: /^[A-Z]{2}$/.test(land) ? land : "NL",
      notities: "Aangemaakt bij omzetten van een factuur",
    },
    gebruiker,
  );
  return { id, nieuw: true };
}

/**
 * Zet een (eigen) factuur die per ongeluk bij de inkoop staat om naar een verkoopfactuur (concept).
 * Bestaat er al een verkoopfactuur met hetzelfde nummer (bv. uit Mollie), dan wordt alleen de dubbele inkoop verwijderd.
 */
export function zetOmNaarVerkoop(ctx: Ctx, inkoopId: number, gebruiker: string, voorstel?: AiVoorstel | null): OmzetResultaat {
  const f = haalFactuur(ctx, "inkoop", inkoopId);
  if (!f) throw new GebruikersFout("Factuur niet gevonden", 404);
  if (f.status !== "te_beoordelen") throw new GebruikersFout("Alleen facturen die nog 'te beoordelen' zijn, kunnen worden omgezet");
  if (ctx.db.get("SELECT 1 FROM transactie_koppelingen WHERE inkoopfactuur_id = ?", [inkoopId])) throw new GebruikersFout("Ontkoppel eerst de banktransactie");
  const v = voorstel ?? (f.ai_voorstel ? (JSON.parse(f.ai_voorstel) as AiVoorstel) : null);
  const factuurnummer = f.factuurnummer ?? v?.factuurnummer ?? null;

  return ctx.db.tx(() => {
    if (factuurnummer) {
      const dubbel = ctx.db.get<{ id: number }>("SELECT id FROM verkoopfacturen WHERE factuurnummer = ? LIMIT 1", [factuurnummer]);
      if (dubbel) {
        ctx.db.run("DELETE FROM inkoopfacturen WHERE id = ?", [inkoopId]);
        audit(ctx.db, gebruiker, "dubbele_eigen_factuur_verwijderd", "inkoopfacturen", inkoopId, { verkoopfactuur: dubbel.id, factuurnummer });
        return { verkoopId: dubbel.id, bestondAl: true, klantAangemaakt: null };
      }
    }

    let klantId: number | null = null;
    let klantAangemaakt: string | null = null;
    if (v?.ontvanger?.naam) {
      const k = klantVoorOntvanger(ctx, v.ontvanger, gebruiker);
      klantId = k.id;
      if (k.nieuw) klantAangemaakt = v.ontvanger.naam;
    }

    const omzet = categorieen(ctx).find((c) => c.soort === "omzet")?.id ?? null;
    // Regels: uit het AI-voorstel (met BTW-code vanuit verkoopperspectief), anders de huidige regels
    const regels = v?.regels?.length
      ? v.regels.map((r) => {
          const code = kiesBtwCode(r.btw_tarief, v.btw_verlegd, v.ontvanger?.land ?? "NL", v.ontvanger?.btw_nummer ?? null);
          return { omschrijving: r.omschrijving.slice(0, 500), categorie_id: omzet, bedrag_excl: Math.round(r.bedrag_excl * 100), btw_code: code, btw_bedrag: Math.round(r.btw_bedrag * 100) };
        })
      : f.regels.map((r) => ({ omschrijving: r.omschrijving, categorie_id: omzet, bedrag_excl: r.bedrag_excl, btw_code: r.btw_code, btw_bedrag: r.btw_bedrag }));
    const verwerkt = verwerkRegels(ctx, "verkoop", regels);
    const datum = (d: string | null | undefined) => (d && isGeldigeDatum(d) ? d : null);

    const verkoopId = ctx.db.run(
      `INSERT INTO verkoopfacturen (relatie_id, factuurnummer, factuurdatum, vervaldatum, omschrijving, totaal_excl, totaal_btw, totaal_incl, status, bron, bijlage_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'concept', 'handmatig', ?)`,
      [
        klantId,
        factuurnummer,
        datum(f.factuurdatum) ?? datum(v?.factuurdatum),
        datum(f.vervaldatum) ?? datum(v?.vervaldatum),
        f.omschrijving,
        verwerkt.totaal_excl,
        verwerkt.totaal_btw,
        verwerkt.totaal_incl,
        f.bijlage_sha256,
      ],
    ).id;
    for (const r of verwerkt.regels) {
      ctx.db.run("INSERT INTO verkoopfactuur_regels (factuur_id, volgorde, omschrijving, categorie_id, bedrag_excl, btw_code, btw_bedrag) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        verkoopId, r.volgorde, r.omschrijving ?? null, r.categorie_id ?? null, r.bedrag_excl, r.btw_code, r.btw_bedrag,
      ]);
    }
    ctx.db.run("DELETE FROM inkoopfacturen WHERE id = ?", [inkoopId]);
    audit(ctx.db, gebruiker, "omgezet_naar_verkoop", "inkoopfacturen", inkoopId, { verkoopfactuur: verkoopId, factuurnummer });
    audit(ctx.db, gebruiker, "aangemaakt_uit_inkoop", "verkoopfacturen", verkoopId, { inkoopfactuur: inkoopId });
    return { verkoopId, bestondAl: false, klantAangemaakt };
  });
}
