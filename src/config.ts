import { z } from "zod";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const bool = z
  .enum(["true", "false", "1", "0", "ja", "nee"])
  .transform((v) => v === "true" || v === "1" || v === "ja");

const leegIsUndefined = (v: unknown) => (v === "" ? undefined : v);
const optioneel = z.preprocess(leegIsUndefined, z.string().optional());

/**
 * Configuratie uit omgevingsvariabelen. Alles is optioneel: de app werkt zonder .env.
 * Koppelingen (Mollie, Claude, Outlook, backup-versleuteling) stel je bij voorkeur in via
 * Instellingen in de webinterface; die waarden gaan vóór op de omgevingsvariabelen (zie lib/instellingen.ts).
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATA_DIR: z.string().default("./data"),
  BACKUP_EXTERN_DIR: optioneel,

  // Sleutel voor versleuteling van tokens/2FA-geheimen/API-sleutels. Leeg = automatisch aangemaakt in DATA_DIR.
  APP_SECRET: z.preprocess(leegIsUndefined, z.string().min(32, "APP_SECRET moet minimaal 32 tekens zijn").optional()),

  // Leeg = automatisch: Secure-cookies alleen bij een HTTPS-verbinding.
  COOKIE_SECURE: z.preprocess(leegIsUndefined, bool.optional()),
  TRUST_PROXY: z.preprocess(leegIsUndefined, z.string().optional()),
  SESSIE_INACTIEF_MINUTEN: z.coerce.number().int().min(5).max(24 * 60).default(30),

  // Backups
  BACKUP_UUR: z.coerce.number().int().min(0).max(23).default(3),
  AGE_PASSPHRASE: optioneel,
  AGE_RECIPIENT: optioneel,

  // Claude (AI-uitlezen)
  ANTHROPIC_API_KEY: optioneel,
  AI_MODEL: z.string().default("claude-sonnet-5-5"),
  // Maximale geschatte AI-kosten per kalendermaand in dollars (0 = AI uit) en maximaal aantal pagina's per PDF
  AI_LIMIET_MAAND: z.coerce.number().min(0).max(10000).default(10),
  AI_MAX_PAGINAS: z.coerce.number().int().min(1).max(100).default(10),

  // Marge-alarm voor doorbelaste inkoop: minimale marge in % over de laatste N volledige maanden
  MARGE_MIN: z.coerce.number().min(0).max(100).default(20),
  MARGE_MAANDEN: z.coerce.number().int().min(1).max(36).default(12),

  // Eigen bedrijf: om eigen (verkoop)facturen te herkennen die per e-mail binnenkomen (bv. in bcc)
  EIGEN_NAAM: optioneel,
  EIGEN_BTW: optioneel,
  EIGEN_KVK: optioneel,

  // Mollie
  MOLLIE_TOKEN: optioneel,
  MOLLIE_TESTMODE: z.preprocess(leegIsUndefined, bool.default(false)),

  // Microsoft 365 / Outlook
  MS_CLIENT_ID: optioneel,
  MS_TENANT_ID: optioneel,
  MS_MAILBOX: optioneel,
  MS_MAP: z.string().default("Facturen"),
  MS_MAP_VERWERKT: z.string().default("Verwerkt"),
  MS_POLL_MINUTEN: z.coerce.number().int().min(5).max(24 * 60).default(15),
});

type Basis = z.infer<typeof schema>;

export type Config = Omit<Basis, "APP_SECRET"> & {
  APP_SECRET: string;
  /** true als APP_SECRET door de app zelf is aangemaakt (opgeslagen in DATA_DIR/app-secret). */
  appSecretAutomatisch: boolean;
  dataDir: string;
  dbPad: string;
  bijlagenDir: string;
  backupDir: string;
  /** Waarden zoals ze uit de omgeving kwamen, als terugvaloptie voor instellingen uit de database. */
  uitOmgeving: Readonly<Basis>;
};

/** Leest DATA_DIR/app-secret of maakt hem aan (alleen leesbaar voor de app). */
function automatischGeheim(dataDir: string): string {
  const pad = path.join(dataDir, "app-secret");
  if (fs.existsSync(pad)) {
    const s = fs.readFileSync(pad, "utf8").trim();
    if (s.length >= 32) return s;
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o750 });
  const s = crypto.randomBytes(48).toString("base64url");
  try {
    fs.writeFileSync(pad, `${s}\n`, { mode: 0o600, flag: "wx" });
  } catch (e) {
    // Een ander proces was ons net voor: gebruik dat geheim
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return fs.readFileSync(pad, "utf8").trim();
    throw e;
  }
  return s;
}

export function laadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const res = schema.safeParse(env);
  if (!res.success) {
    const fouten = res.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Ongeldige configuratie (omgevingsvariabelen):\n${fouten}`);
  }
  const c = res.data;
  if (c.AGE_PASSPHRASE && c.AGE_RECIPIENT) {
    throw new Error("Stel óf AGE_PASSPHRASE óf AGE_RECIPIENT in, niet beide.");
  }
  const dataDir = path.resolve(c.DATA_DIR);
  return {
    ...c,
    APP_SECRET: c.APP_SECRET ?? automatischGeheim(dataDir),
    appSecretAutomatisch: !c.APP_SECRET,
    dataDir,
    dbPad: path.join(dataDir, "boekhouding.sqlite"),
    bijlagenDir: path.join(dataDir, "attachments"),
    backupDir: path.join(dataDir, "backups"),
    uitOmgeving: Object.freeze({ ...c }),
  };
}
