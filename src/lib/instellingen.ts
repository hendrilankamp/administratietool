import { z } from "zod";
import type { Ctx } from "./context.ts";
import { audit, GebruikersFout, getInstelling, setInstelling } from "./context.ts";
import { ontsleutel, versleutel } from "./crypto.ts";

/**
 * Koppelingen die je in de webinterface instelt. Ze worden in de tabel `instellingen` opgeslagen
 * (geheimen versleuteld met APP_SECRET) en gaan vóór op omgevingsvariabelen.
 */
export const INSTELBAAR = {
  ANTHROPIC_API_KEY: { geheim: true, schema: z.string().regex(/^sk-ant-[\w-]{10,}$/, "Een Anthropic API-sleutel begint met sk-ant-") },
  AI_MODEL: { geheim: false, schema: z.string().regex(/^claude-[a-z0-9.-]{3,60}$/, "Ongeldige modelnaam") },
  AI_LIMIET_MAAND: { geheim: false, schema: z.number().min(0, "Limiet kan niet negatief zijn").max(10000) },
  AI_MAX_PAGINAS: { geheim: false, schema: z.number().int().min(1).max(100) },
  MARGE_MIN: { geheim: false, schema: z.number().min(0).max(100) },
  MARGE_MAANDEN: { geheim: false, schema: z.number().int().min(1).max(36) },
  // Bedrijfsgegevens: meerdere waarden mogelijk (bv. oud en nieuw BTW-nummer)
  EIGEN_NAAM: { geheim: false, schema: z.array(z.string().trim().min(2, "Bedrijfsnaam is te kort").max(100)).min(1).max(10) },
  EIGEN_BTW: {
    geheim: false,
    schema: z
      .array(z.string().transform((s) => s.replace(/[\s.\-]/g, "").toUpperCase()).pipe(z.string().regex(/^[A-Z]{2}[0-9A-Z]{8,12}$/, "Ongeldig BTW-nummer")))
      .min(1)
      .max(10),
  },
  EIGEN_KVK: { geheim: false, schema: z.array(z.string().transform((s) => s.replace(/\D/g, "")).pipe(z.string().regex(/^\d{8}$/, "KvK-nummer heeft 8 cijfers"))).min(1).max(10) },
  MOLLIE_TOKEN: { geheim: true, schema: z.string().regex(/^(access|live|test)_[\w]{10,}$/, "Een Mollie-token begint met access_, live_ of test_") },
  MOLLIE_TESTMODE: { geheim: false, schema: z.boolean() },
  MS_CLIENT_ID: { geheim: false, schema: z.guid("Toepassings-ID moet een GUID zijn (8-4-4-4-12 tekens, bv. 6496e63c-96ca-4862-a664-0fd54b21e9fe)") },
  MS_TENANT_ID: { geheim: false, schema: z.union([z.guid(), z.string().regex(/^[\w.-]+\.[a-z]{2,}$/)], { error: "Map-ID moet een GUID (8-4-4-4-12 tekens) of domeinnaam zijn" }) },
  MS_MAILBOX: { geheim: false, schema: z.email("Vul het e-mailadres van de gedeelde mailbox in").max(200) },
  MS_MAP: { geheim: false, schema: z.string().trim().min(1).max(100) },
  MS_MAP_VERWERKT: { geheim: false, schema: z.string().trim().min(1).max(100) },
  MS_POLL_MINUTEN: { geheim: false, schema: z.number().int().min(5).max(24 * 60) },
  AGE_PASSPHRASE: { geheim: true, schema: z.string().min(12, "Gebruik een wachtwoordzin van minimaal 12 tekens") },
  AGE_RECIPIENT: { geheim: false, schema: z.string().regex(/^age1[0-9a-z]{58}$/, "Een publieke age-sleutel begint met age1") },
  BACKUP_UUR: { geheim: false, schema: z.number().int().min(0).max(23) },
} as const;

export type InstelSleutel = keyof typeof INSTELBAAR;
const PREFIX = "koppeling.";

function lees(ctx: Ctx, sleutel: InstelSleutel): unknown {
  const ruw = getInstelling(ctx.db, PREFIX + sleutel);
  if (ruw === undefined) return undefined;
  try {
    const tekst = INSTELBAAR[sleutel].geheim ? ontsleutel(ruw, ctx.config.APP_SECRET, `instelling:${sleutel}`) : ruw;
    return JSON.parse(tekst);
  } catch {
    ctx.log.error(`Instelling ${sleutel} kon niet worden gelezen (andere APP_SECRET na herstel?). Vul hem opnieuw in.`);
    return undefined;
  }
}

/** Herberekent de effectieve configuratie: instelling uit de database, anders de omgevingsvariabele. */
export function pasInstellingenToe(ctx: Ctx): void {
  const c = ctx.config as unknown as Record<string, unknown>;
  const env = ctx.config.uitOmgeving as unknown as Record<string, unknown>;
  for (const sleutel of Object.keys(INSTELBAAR) as InstelSleutel[]) {
    const waarde = lees(ctx, sleutel);
    c[sleutel] = waarde !== undefined ? waarde : env[sleutel];
  }
  // Nooit beide age-varianten tegelijk
  if (ctx.config.AGE_RECIPIENT && lees(ctx, "AGE_RECIPIENT") !== undefined) ctx.config.AGE_PASSPHRASE = undefined;
}

export interface Wijziging {
  sleutel: InstelSleutel;
  /** undefined = niet wijzigen, null = wissen */
  waarde: unknown;
}

export function slaInstellingenOp(ctx: Ctx, wijzigingen: Wijziging[], gebruiker: string): void {
  const geldig = wijzigingen.map((w) => {
    if (w.waarde === undefined || w.waarde === null) return w;
    const r = INSTELBAAR[w.sleutel].schema.safeParse(w.waarde);
    if (!r.success) throw new GebruikersFout(`${w.sleutel}: ${r.error.issues[0]?.message ?? "ongeldig"}`);
    return { ...w, waarde: r.data };
  });
  ctx.db.tx(() => {
    for (const w of geldig) {
      if (w.waarde === undefined) continue;
      if (w.waarde === null) {
        ctx.db.run("DELETE FROM instellingen WHERE sleutel = ?", [PREFIX + w.sleutel]);
        continue;
      }
      const json = JSON.stringify(w.waarde);
      setInstelling(ctx.db, PREFIX + w.sleutel, INSTELBAAR[w.sleutel].geheim ? versleutel(json, ctx.config.APP_SECRET, `instelling:${w.sleutel}`) : json);
    }
    // Wie een publieke sleutel kiest, wist de wachtwoordzin (en omgekeerd)
    const nieuw = Object.fromEntries(geldig.filter((w) => w.waarde).map((w) => [w.sleutel, true]));
    if (nieuw.AGE_RECIPIENT) ctx.db.run("DELETE FROM instellingen WHERE sleutel = ?", [`${PREFIX}AGE_PASSPHRASE`]);
    if (nieuw.AGE_PASSPHRASE) ctx.db.run("DELETE FROM instellingen WHERE sleutel = ?", [`${PREFIX}AGE_RECIPIENT`]);
    audit(ctx.db, gebruiker, "instellingen_gewijzigd", "instellingen", undefined, {
      // Nooit de geheime waarden zelf loggen
      gewijzigd: geldig.filter((w) => w.waarde !== undefined).map((w) => `${w.sleutel}${w.waarde === null ? " (gewist)" : ""}`),
    });
  });
  pasInstellingenToe(ctx);
}

/** Bron van een instelling, voor weergave: 'app', 'omgeving' of 'geen'. */
export function bronVan(ctx: Ctx, sleutel: InstelSleutel): "app" | "omgeving" | "geen" {
  if (getInstelling(ctx.db, PREFIX + sleutel) !== undefined) return "app";
  const env = (ctx.config.uitOmgeving as unknown as Record<string, unknown>)[sleutel];
  return env !== undefined && env !== "" ? "omgeving" : "geen";
}

