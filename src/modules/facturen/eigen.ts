import type { Ctx } from "../../lib/context.ts";
import { audit } from "../../lib/context.ts";
import { normaliseerBtwNummer, normNaam } from "../relaties/service.ts";
import { zetOmNaarVerkoop } from "./omzetten.ts";
import { mollieIngesteld } from "../../integrations/mollie/index.ts";

/**
 * Herkent eigen (verkoop)facturen die per e-mail binnenkomen, bv. omdat je in de bcc staat
 * of Mollie een kopie stuurt ("Nieuwe factuur van Medialan"). Die horen niet bij de inkoop.
 */

/** Waarden van een bedrijfsgegeven als lijst (instelling kan een lijst zijn, omgevingsvariabele komma-gescheiden). */
export function eigenWaarden(ctx: Ctx, sleutel: "EIGEN_NAAM" | "EIGEN_BTW" | "EIGEN_KVK"): string[] {
  const w = (ctx.config as unknown as Record<string, unknown>)[sleutel];
  const lijst = Array.isArray(w) ? w : typeof w === "string" ? w.split(sleutel === "EIGEN_NAAM" ? /\n/ : /[\n,;]+/) : [];
  return lijst.map((x) => String(x).trim()).filter(Boolean);
}

export function eigenGegevensIngesteld(ctx: Ctx): boolean {
  return eigenWaarden(ctx, "EIGEN_NAAM").length + eigenWaarden(ctx, "EIGEN_BTW").length + eigenWaarden(ctx, "EIGEN_KVK").length > 0;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Onderwerp zoals "Nieuwe factuur van Medialan" / "Invoice from Medialan" / "Uw factuur van Medialan". */
export function isEigenOnderwerp(ctx: Ctx, onderwerp: string | null | undefined): boolean {
  if (!onderwerp) return false;
  return eigenWaarden(ctx, "EIGEN_NAAM").some((naam) =>
    new RegExp(`\\b(factuur|invoice|creditnota|credit note)\\s+(van|from)\\s+${escapeRegex(naam)}\\b`, "i").test(onderwerp),
  );
}

/** Leverancier op de factuur is ons eigen bedrijf (BTW-nummer, KvK of naam). */
export function isEigenLeverancier(ctx: Ctx, l: { naam?: string | null; btw_nummer?: string | null; kvk?: string | null }): boolean {
  if (l.btw_nummer) {
    const btw = normaliseerBtwNummer(l.btw_nummer);
    if (eigenWaarden(ctx, "EIGEN_BTW").some((e) => normaliseerBtwNummer(e) === btw)) return true;
  }
  if (l.kvk) {
    const kvk = l.kvk.replace(/\D/g, "");
    if (eigenWaarden(ctx, "EIGEN_KVK").some((e) => e.replace(/\D/g, "") === kvk)) return true;
  }
  if (l.naam) {
    const a = normNaam(l.naam);
    return eigenWaarden(ctx, "EIGEN_NAAM").some((naam) => {
      const b = normNaam(naam);
      return b.length >= 3 && (a === b || (a.startsWith(b) && a.length - b.length <= 4));
    });
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
  if (!eigenGegevensIngesteld(ctx)) return res;
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
