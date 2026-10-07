import type { Ctx } from "../../lib/context.ts";
import { audit } from "../../lib/context.ts";
import { normaliseerBtwNummer, normNaam } from "../relaties/service.ts";
import { zetOmNaarVerkoop } from "./omzetten.ts";
import { mollieIngesteld } from "../../integrations/mollie/index.ts";

/**
 * Herkent eigen (verkoop)facturen die per e-mail binnenkomen, bv. omdat je in de bcc staat
 * of Mollie een kopie stuurt ("Nieuwe factuur van Medialan"). Die horen niet bij de inkoop.
 */

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Onderwerp zoals "Nieuwe factuur van Medialan" / "Invoice from Medialan" / "Uw factuur van Medialan". */
export function isEigenOnderwerp(ctx: Ctx, onderwerp: string | null | undefined): boolean {
  const naam = ctx.config.EIGEN_NAAM?.trim();
  if (!naam || !onderwerp) return false;
  return new RegExp(`\\b(factuur|invoice|creditnota|credit note)\\s+(van|from)\\s+${escapeRegex(naam)}\\b`, "i").test(onderwerp);
}

/** Leverancier op de factuur is ons eigen bedrijf (BTW-nummer, KvK of naam). */
export function isEigenLeverancier(ctx: Ctx, l: { naam?: string | null; btw_nummer?: string | null; kvk?: string | null }): boolean {
  const { EIGEN_NAAM, EIGEN_BTW, EIGEN_KVK } = ctx.config;
  if (EIGEN_BTW && l.btw_nummer && normaliseerBtwNummer(l.btw_nummer) === normaliseerBtwNummer(EIGEN_BTW)) return true;
  if (EIGEN_KVK && l.kvk && l.kvk.replace(/\D/g, "") === EIGEN_KVK) return true;
  if (EIGEN_NAAM && l.naam) {
    const a = normNaam(l.naam);
    const b = normNaam(EIGEN_NAAM);
    return b.length >= 3 && (a === b || (a.startsWith(b) && a.length - b.length <= 4));
  }
  return false;
}

/** Verwijdert een te beoordelen inkoopfactuur omdat het een eigen factuur is. */
export function negeerEigenFactuur(ctx: Ctx, factuurId: number, reden: string): boolean {
  const r = ctx.db.run(
    "DELETE FROM inkoopfacturen WHERE id = ? AND status = 'te_beoordelen' AND NOT EXISTS (SELECT 1 FROM transactie_koppelingen WHERE inkoopfactuur_id = ?)",
    [factuurId, factuurId],
  );
  if (r.changes) audit(ctx.db, "systeem", "eigen_factuur_genegeerd", "inkoopfacturen", factuurId, { reden });
  return r.changes > 0;
}

/**
 * Verwerkt eigen facturen in "te beoordelen": met een AI-voorstel → omzetten naar verkoop (of verwijderen als
 * hij daar al staat); alleen herkend op onderwerp en Mollie is gekoppeld → verwijderen (komt via Mollie binnen).
 */
export function ruimEigenFacturenOp(ctx: Ctx): { omgezet: number; verwijderd: number } {
  const res = { omgezet: 0, verwijderd: 0 };
  if (!ctx.config.EIGEN_NAAM && !ctx.config.EIGEN_BTW && !ctx.config.EIGEN_KVK) return res;
  const rijen = ctx.db.all<{ id: number; ai_voorstel: string | null; onderwerp: string | null; omschrijving: string | null }>(
    `SELECT f.id, f.ai_voorstel, e.onderwerp, f.omschrijving FROM inkoopfacturen f
     LEFT JOIN email_berichten e ON e.id = f.email_bericht_id WHERE f.status = 'te_beoordelen'`,
  );
  for (const r of rijen) {
    let voorstelEigen = false;
    if (r.ai_voorstel) {
      try {
        voorstelEigen = isEigenLeverancier(ctx, JSON.parse(r.ai_voorstel).leverancier ?? {});
      } catch {
        // ongeldig voorstel
      }
    }
    try {
      if (voorstelEigen) {
        const o = zetOmNaarVerkoop(ctx, r.id, "systeem");
        if (o.bestondAl) res.verwijderd++;
        else res.omgezet++;
      } else if (isEigenOnderwerp(ctx, r.onderwerp ?? r.omschrijving) && mollieIngesteld(ctx)) {
        if (negeerEigenFactuur(ctx, r.id, "opgeruimd: kopie van Mollie-factuur")) res.verwijderd++;
      }
    } catch (e) {
      ctx.log.warn(`Eigen factuur #${r.id} niet verwerkt: ${(e as Error).message}`);
    }
  }
  return res;
}
