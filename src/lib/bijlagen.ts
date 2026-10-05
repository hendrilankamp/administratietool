import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./crypto.ts";
import { GebruikersFout, type Ctx } from "./context.ts";

export const MAX_BIJLAGE = 20 * 1024 * 1024;

const TYPES: { mime: string; ext: string; magic: (b: Buffer) => boolean }[] = [
  { mime: "application/pdf", ext: "pdf", magic: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { mime: "image/png", ext: "png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];

/** Bepaalt het type op basis van de inhoud (niet de bestandsnaam). */
export function detecteerType(data: Buffer): { mime: string; ext: string } | null {
  const t = TYPES.find((t) => t.magic(data));
  return t ? { mime: t.mime, ext: t.ext } : null;
}

export function bijlagePad(ctx: Ctx, hash: string, ext: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Ongeldige hash");
  return path.join(ctx.config.bijlagenDir, `${hash}.${ext}`);
}

const extVanMime = (mime: string) => TYPES.find((t) => t.mime === mime)?.ext ?? "bin";

/**
 * Slaat een bijlage op onder zijn sha256 (ontdubbeling) en registreert hem in de database.
 * Gooit een GebruikersFout bij een niet-toegestaan type of te groot bestand.
 */
export function bewaarBijlage(ctx: Ctx, data: Buffer, bestandsnaam: string): { sha256: string; mime: string; nieuw: boolean } {
  if (data.length === 0) throw new GebruikersFout("Leeg bestand");
  if (data.length > MAX_BIJLAGE) throw new GebruikersFout("Bestand is groter dan 20 MB");
  const type = detecteerType(data);
  if (!type) throw new GebruikersFout("Alleen PDF, PNG of JPG is toegestaan");
  const hash = sha256(data);
  const pad = bijlagePad(ctx, hash, type.ext);
  const bestaand = ctx.db.get("SELECT sha256 FROM bijlagen WHERE sha256 = ?", [hash]);
  if (!fs.existsSync(pad)) {
    fs.mkdirSync(path.dirname(pad), { recursive: true });
    const tmp = `${pad}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data, { mode: 0o640 });
    fs.renameSync(tmp, pad);
  }
  if (!bestaand) {
    const naam = path.basename(bestandsnaam).replace(/[^\w.\- ()]/g, "_").slice(0, 200) || `bijlage.${type.ext}`;
    ctx.db.run("INSERT INTO bijlagen (sha256, bestandsnaam, mime, grootte) VALUES (?, ?, ?, ?)", [hash, naam, type.mime, data.length]);
  }
  return { sha256: hash, mime: type.mime, nieuw: !bestaand };
}

export function leesBijlage(ctx: Ctx, hash: string): { data: Buffer; mime: string; bestandsnaam: string } | null {
  const rij = ctx.db.get<{ mime: string; bestandsnaam: string }>("SELECT mime, bestandsnaam FROM bijlagen WHERE sha256 = ?", [hash]);
  if (!rij) return null;
  const pad = bijlagePad(ctx, hash, extVanMime(rij.mime));
  if (!fs.existsSync(pad)) return null;
  return { data: fs.readFileSync(pad), mime: rij.mime, bestandsnaam: rij.bestandsnaam };
}

export function bijlageBestandsnaamOpSchijf(hash: string, mime: string): string {
  return `${hash}.${extVanMime(mime)}`;
}
