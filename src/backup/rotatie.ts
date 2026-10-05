import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../lib/context.ts";

export interface RotatieBeleid {
  dagelijks: number;
  wekelijks: number;
  maandelijks: number;
  jaarlijks: number; // aantal jaren; fiscale bewaarplicht is 7 jaar
}

export const STANDAARD_BELEID: RotatieBeleid = { dagelijks: 7, wekelijks: 4, maandelijks: 12, jaarlijks: 10 };

const p2 = (n: number) => String(n).padStart(2, "0");

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dag = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dag);
  const jaarStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - jaarStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${p2(week)}`;
}

/**
 * Bepaalt welke backups bewaard blijven (grandfather-father-son).
 * Per dag/week/maand/jaar blijft de nieuwste backup bewaard; alles van de laatste 48 uur blijft altijd staan.
 */
export function teBewaren(datums: Date[], nu: Date = new Date(), beleid: RotatieBeleid = STANDAARD_BELEID): Set<number> {
  const gesorteerd = datums.map((d, i) => ({ d, i })).sort((a, b) => b.d.getTime() - a.d.getTime());
  const bewaar = new Set<number>();
  const emmers: [keyof RotatieBeleid, (d: Date) => string][] = [
    ["dagelijks", (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`],
    ["wekelijks", isoWeek],
    ["maandelijks", (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}`],
    ["jaarlijks", (d) => String(d.getFullYear())],
  ];
  for (const [soort, sleutel] of emmers) {
    const gezien = new Set<string>();
    for (const { d, i } of gesorteerd) {
      const k = sleutel(d);
      if (gezien.has(k)) continue;
      if (gezien.size >= beleid[soort]) break;
      gezien.add(k);
      bewaar.add(i);
    }
  }
  for (const { d, i } of gesorteerd) if (nu.getTime() - d.getTime() < 48 * 3600 * 1000) bewaar.add(i);
  return bewaar;
}

export function roteer(dir: string, ext: string, log: Logger, nu: Date = new Date()): string[] {
  if (!fs.existsSync(dir)) return [];
  const bestanden = fs.readdirSync(dir).filter((f) => f.startsWith("medialan-backup-") && f.endsWith(ext));
  const datums = bestanden.map((f) => {
    const m = /medialan-backup-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(f);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : fs.statSync(path.join(dir, f)).mtime;
  });
  const bewaar = teBewaren(datums, nu);
  const verwijderd: string[] = [];
  bestanden.forEach((f, i) => {
    if (!bewaar.has(i)) {
      fs.rmSync(path.join(dir, f), { force: true });
      verwijderd.push(f);
    }
  });
  if (verwijderd.length) log.info(`Backuprotatie: ${verwijderd.length} oude backup(s) verwijderd uit ${dir}`);
  return verwijderd;
}
