import crypto from "node:crypto";

// ---------- Symmetrische versleuteling (AES-256-GCM) met sleutel afgeleid van APP_SECRET ----------

function sleutel(appSecret: string, doel: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", appSecret, "boekhouding-medialan", doel, 32));
}

/** Versleutelt tekst; resultaat: "v1.<iv>.<tag>.<data>" (base64url). */
export function versleutel(tekst: string, appSecret: string, doel: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", sleutel(appSecret, doel), iv);
  const data = Buffer.concat([c.update(tekst, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function ontsleutel(blob: string, appSecret: string, doel: string): string {
  const [v, iv, tag, data] = blob.split(".");
  if (v !== "v1" || !iv || !tag || data === undefined) throw new Error("Onbekend versleutelingsformaat");
  const d = crypto.createDecipheriv("aes-256-gcm", sleutel(appSecret, doel), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}

// ---------- Wachtwoorden (scrypt) ----------

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashWachtwoord(wachtwoord: string): string {
  const zout = crypto.randomBytes(16);
  const hash = crypto.scryptSync(wachtwoord.normalize("NFKC"), zout, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${zout.toString("base64url")}$${hash.toString("base64url")}`;
}

export function controleerWachtwoord(wachtwoord: string, opgeslagen: string): boolean {
  const delen = opgeslagen.split("$");
  if (delen.length !== 6 || delen[0] !== "scrypt") return false;
  const [, N, r, p, zout, hash] = delen;
  const verwacht = Buffer.from(hash, "base64url");
  const berekend = crypto.scryptSync(wachtwoord.normalize("NFKC"), Buffer.from(zout, "base64url"), verwacht.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(verwacht, berekend);
}

// ---------- TOTP (RFC 6238, SHA-1, 6 cijfers, 30 s) ----------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function nieuwTotpGeheim(): string {
  const bytes = crypto.randomBytes(20);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[Number.parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(s: string): Buffer {
  const schoon = s.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = "";
  for (const ch of schoon) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("Ongeldig base32-teken");
    bits += i.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpCode(geheim: string, tijdMs: number = Date.now()): string {
  const teller = Math.floor(tijdMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(teller));
  const h = crypto.createHmac("sha1", base32Decode(geheim)).update(buf).digest();
  const o = h[h.length - 1] & 0x0f;
  const code = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

/** Accepteert de code van het huidige venster en één venster ervoor/erna (klokafwijking). */
export function controleerTotp(geheim: string, code: string, tijdMs: number = Date.now()): boolean {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  for (const delta of [-1, 0, 1]) {
    const verwacht = totpCode(geheim, tijdMs + delta * 30_000);
    if (crypto.timingSafeEqual(Buffer.from(verwacht), Buffer.from(c))) return true;
  }
  return false;
}

export function totpUri(geheim: string, gebruiker: string, uitgever = "Boekhouding Medialan"): string {
  const label = encodeURIComponent(`${uitgever}:${gebruiker}`);
  return `otpauth://totp/${label}?secret=${geheim}&issuer=${encodeURIComponent(uitgever)}&algorithm=SHA1&digits=6&period=30`;
}

// ---------- Overig ----------

export function sha256(data: Buffer | Uint8Array | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function willekeurigToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function gelijk(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
