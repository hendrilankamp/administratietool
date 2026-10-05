import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough } from "fflate";

/** Schrijft een zip-bestand streamend naar schijf (geen volledige kopie in het geheugen). */
export class ZipSchrijver {
  private readonly fd: number;
  private readonly zip: Zip;
  private fout: Error | null = null;
  private klaar = false;
  private klaarResolve?: () => void;

  constructor(pad: string) {
    this.fd = fs.openSync(pad, "w", 0o640);
    this.zip = new Zip((err, chunk, final) => {
      if (err) {
        this.fout = err;
        return;
      }
      fs.writeSync(this.fd, chunk);
      if (final) {
        this.klaar = true;
        this.klaarResolve?.();
      }
    });
  }

  /** Voegt een bestand toe; `comprimeer: false` voor al gecomprimeerde data (PDF/JPG). */
  voegToe(naam: string, data: Uint8Array | string, comprimeer = true): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const f = comprimeer ? new ZipDeflate(naam, { level: 6 }) : new ZipPassThrough(naam);
    f.mtime = new Date();
    this.zip.add(f);
    f.push(bytes, true);
    if (this.fout) throw this.fout;
  }

  async sluit(): Promise<void> {
    const p = new Promise<void>((resolve) => {
      if (this.klaar) resolve();
      else this.klaarResolve = resolve;
    });
    this.zip.end();
    await p;
    fs.closeSync(this.fd);
    if (this.fout) throw this.fout;
  }
}

export interface ZipItem {
  naam: string;
  sha256: string;
  grootte: number;
}

/**
 * Leest een zip-bestand streamend. Voor elk bestand wordt de sha256 berekend;
 * `doel` (optioneel) bepaalt per bestand of en waar het wordt uitgepakt, of geeft "geheugen" om de inhoud terug te krijgen.
 */
export async function leesZip(
  pad: string,
  doel?: (naam: string) => string | "geheugen" | null,
): Promise<{ items: ZipItem[]; inhoud: Map<string, Buffer> }> {
  const items: ZipItem[] = [];
  const inhoud = new Map<string, Buffer>();
  const openstaand: Promise<void>[] = [];
  let fout: Error | null = null;

  const unzip = new Unzip((bestand) => {
    const naam = bestand.name;
    if (naam.endsWith("/")) return;
    if (!veiligeNaam(naam)) {
      fout = new Error(`Onveilige bestandsnaam in zip: ${naam}`);
      return;
    }
    const bestemming = doel ? doel(naam) : null;
    const hash = crypto.createHash("sha256");
    const delen: Buffer[] = [];
    let grootte = 0;
    let fd: number | null = null;
    if (bestemming && bestemming !== "geheugen") {
      fs.mkdirSync(path.dirname(bestemming), { recursive: true });
      fd = fs.openSync(bestemming, "w", 0o640);
    }
    openstaand.push(
      new Promise<void>((resolve) => {
        bestand.ondata = (err, chunk, final) => {
          if (err) {
            fout = err;
            resolve();
            return;
          }
          hash.update(chunk);
          grootte += chunk.length;
          if (fd !== null) fs.writeSync(fd, chunk);
          else if (bestemming === "geheugen") delen.push(Buffer.from(chunk));
          if (final) {
            if (fd !== null) fs.closeSync(fd);
            if (bestemming === "geheugen") inhoud.set(naam, Buffer.concat(delen));
            items.push({ naam, sha256: hash.digest("hex"), grootte });
            resolve();
          }
        };
      }),
    );
    bestand.start();
  });
  unzip.register(UnzipInflate);

  const fd = fs.openSync(pad, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) {
        unzip.push(new Uint8Array(0), true);
        break;
      }
      unzip.push(new Uint8Array(buf.subarray(0, n)), false);
      if (fout) break;
    }
  } finally {
    fs.closeSync(fd);
  }
  await Promise.all(openstaand);
  if (fout) throw fout;
  return { items, inhoud };
}

export function veiligeNaam(naam: string): boolean {
  if (naam.includes("\\") || naam.includes("\0") || naam.startsWith("/")) return false;
  const norm = path.posix.normalize(naam);
  return norm === naam && !norm.split("/").includes("..");
}
