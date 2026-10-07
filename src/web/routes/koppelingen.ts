import type { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { generateIdentity, identityToRecipient } from "age-encryption";
import type { Ctx } from "../../lib/context.ts";
import { audit, GebruikersFout } from "../../lib/context.ts";
import { controleerWachtwoord } from "../../lib/crypto.ts";
import { bronVan, INSTELBAAR, slaInstellingenOp, type InstelSleutel, type Wijziging } from "../../lib/instellingen.ts";
import { klaar, render, tekst } from "../render.ts";
import { ruimEigenFacturenOp } from "../../modules/facturen/eigen.ts";

/** Overzicht van alle koppel-instellingen voor de view (geheimen worden nooit teruggestuurd). */
export function koppelingInfo(ctx: Ctx) {
  const c = ctx.config as unknown as Record<string, unknown>;
  return Object.fromEntries(
    (Object.keys(INSTELBAAR) as InstelSleutel[]).map((k) => [
      k,
      { ingesteld: c[k] !== undefined && c[k] !== null && c[k] !== "", bron: bronVan(ctx, k), waarde: INSTELBAAR[k].geheim ? null : c[k] },
    ]),
  );
}

export function koppelingenRoutes(ctx: Ctx, r: Router): void {
  const gebruiker = (req: Express.Request) => req.sessie!.gebruikersnaam!;

  r.post("/koppelingen", (req, res) => {
    const b = req.body as Record<string, unknown>;
    const sectie = String(b.sectie ?? "");
    const wijzigingen: Wijziging[] = [];
    const veld = (k: InstelSleutel, soort: "tekst" | "getal" | "vinkje" = "tekst") => {
      if (b[`wis_${k}`] === "1") return wijzigingen.push({ sleutel: k, waarde: null });
      if (soort === "vinkje") return wijzigingen.push({ sleutel: k, waarde: b[k] === "1" });
      let t = tekst(b[k], 500);
      // Bij kopiëren uit portals komen soms onzichtbare tekens of labels mee: haal er de GUID uit
      if (t && (k === "MS_CLIENT_ID" || k === "MS_TENANT_ID")) {
        const schoon = t.replace(/[\s\u00a0\u200b-\u200f\u2060\ufeff]/g, "");
        t = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(schoon)?.[0].toLowerCase() ?? schoon;
      }
      // Geheimen: leeg laten = ongewijzigd. Overige velden: leeg = terug naar standaard.
      if (t === null) return wijzigingen.push({ sleutel: k, waarde: INSTELBAAR[k].geheim ? undefined : null });
      wijzigingen.push({ sleutel: k, waarde: soort === "getal" ? Number(t.replace(",", ".")) : t });
    };
    if (sectie === "mollie") {
      veld("MOLLIE_TOKEN");
      veld("MOLLIE_TESTMODE", "vinkje");
    } else if (sectie === "ai") {
      veld("ANTHROPIC_API_KEY");
      veld("AI_MODEL");
      veld("AI_LIMIET_MAAND", "getal");
      veld("AI_MAX_PAGINAS", "getal");
    } else if (sectie === "bedrijf") {
      veld("EIGEN_NAAM");
      veld("EIGEN_BTW");
      veld("EIGEN_KVK");
    } else if (sectie === "outlook") {
      veld("MS_CLIENT_ID");
      veld("MS_TENANT_ID");
    } else if (sectie === "mailbox") {
      veld("MS_MAILBOX");
      veld("MS_MAP");
      veld("MS_MAP_VERWERKT");
      veld("MS_POLL_MINUTEN", "getal");
    } else if (sectie === "backup") {
      if (tekst(b.AGE_PASSPHRASE) && tekst(b.AGE_PASSPHRASE) !== tekst(b.AGE_PASSPHRASE2)) throw new GebruikersFout("De wachtwoordzinnen komen niet overeen");
      veld("AGE_PASSPHRASE");
      veld("BACKUP_UUR", "getal");
    } else throw new GebruikersFout("Onbekend onderdeel");
    slaInstellingenOp(ctx, wijzigingen, gebruiker(req));
    let extra = "";
    if (sectie === "bedrijf") {
      const n = ruimEigenFacturenOp(ctx);
      if (n.omgezet || n.verwijderd) extra = ` Eigen facturen in "te beoordelen": ${n.omgezet} omgezet naar verkoop (concept), ${n.verwijderd} dubbele verwijderd.`;
    }
    klaar(ctx, req, res, `/instellingen#${sectie === "mailbox" ? "outlook" : sectie}`, `Instellingen opgeslagen.${extra}`);
  });

  r.post("/test/mollie", async (req, res) => {
    if (!ctx.config.MOLLIE_TOKEN) throw new GebruikersFout("Vul eerst een Mollie-token in");
    const kop = { Authorization: `Bearer ${ctx.config.MOLLIE_TOKEN}` };
    const qs = ctx.config.MOLLIE_TESTMODE ? "&testmode=true" : "";
    const f = await fetch(`https://api.mollie.com/v2/sales-invoices?limit=1${qs}`, { headers: kop, signal: AbortSignal.timeout(20_000) });
    if (!f.ok) throw new GebruikersFout(`Mollie-facturen: geen toegang (${f.status}). Controleer het token en het recht sales-invoices.read.`);
    const s = await fetch(`https://api.mollie.com/v2/settlements?limit=1${qs}`, { headers: kop, signal: AbortSignal.timeout(20_000) });
    klaar(ctx, req, res, "/instellingen#mollie", s.ok ? "Mollie werkt: facturen én uitbetalingen zijn bereikbaar." : `Facturen werken, maar uitbetalingen niet (${s.status}): gebruik een Organization access token met settlements.read.`);
  });

  r.post("/test/ai", async (req, res) => {
    if (!ctx.config.ANTHROPIC_API_KEY) throw new GebruikersFout("Vul eerst een API-sleutel in");
    try {
      const m = await new Anthropic({ apiKey: ctx.config.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 20_000 }).models.retrieve(ctx.config.AI_MODEL);
      klaar(ctx, req, res, "/instellingen#ai", `Claude werkt (model ${m.display_name ?? m.id}).`);
    } catch (e) {
      const st = e instanceof Anthropic.APIError ? e.status : undefined;
      throw new GebruikersFout(st === 401 ? "Claude: API-sleutel ongeldig." : st === 404 ? `Claude: model ${ctx.config.AI_MODEL} niet gevonden.` : `Claude niet bereikbaar: ${(e as Error).message}`);
    }
  });

  /** Maakt een age-sleutelpaar: de publieke sleutel wordt opgeslagen, de geheime sleutel één keer getoond. */
  r.post("/age-sleutelpaar", async (req, res) => {
    const id = await generateIdentity();
    const ontvanger = await identityToRecipient(id);
    slaInstellingenOp(ctx, [{ sleutel: "AGE_RECIPIENT", waarde: ontvanger }], gebruiker(req));
    audit(ctx.db, gebruiker(req), "age_sleutelpaar_aangemaakt", "instellingen", undefined, { ontvanger });
    render(ctx, req, res, "geheim-tonen", {
      titel: "Geheime backupsleutel",
      kop: "Bewaar deze sleutel nu",
      uitleg: "Hiermee ontsleutel je de externe backups. De app bewaart alleen de publieke sleutel; deze geheime sleutel wordt niet opgeslagen en wordt maar één keer getoond. Zet hem in je wachtwoordmanager (of als bestand medialan.key op een USB-stick).",
      geheim: `# publieke sleutel: ${ontvanger}\n${id}`,
      bestandsnaam: "medialan-backup.key",
      terug: "/instellingen#backup",
    });
  });

  /** Toont de APP_SECRET na opnieuw invoeren van het wachtwoord (nodig om na een herstel op nieuwe hardware alles te kunnen lezen). */
  r.post("/herstelsleutel", (req, res) => {
    const g = ctx.db.get<{ wachtwoord_hash: string }>("SELECT wachtwoord_hash FROM gebruikers WHERE id = ?", [req.sessie!.gebruiker_id]);
    if (!g || !controleerWachtwoord(String(req.body.wachtwoord ?? ""), g.wachtwoord_hash)) throw new GebruikersFout("Wachtwoord klopt niet");
    audit(ctx.db, gebruiker(req), "herstelsleutel_bekeken", "instellingen");
    render(ctx, req, res, "geheim-tonen", {
      titel: "Herstelsleutel",
      kop: "Herstelsleutel (APP_SECRET)",
      uitleg: "Met deze sleutel zijn de opgeslagen API-sleutels, de Outlook-koppeling en de 2FA-geheimen te lezen na een herstel op een nieuwe NAS. Bewaar hem in je wachtwoordmanager. Bij herstel: zet hem terug als bestand app-secret in de datamap (of als omgevingsvariabele APP_SECRET).",
      geheim: ctx.config.APP_SECRET,
      bestandsnaam: "app-secret",
      terug: "/instellingen#backup",
    });
  });
}
