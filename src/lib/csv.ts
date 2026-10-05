/** CSV-uitvoer (RFC 4180, standaard ';' voor Nederlandse Excel), met bescherming tegen formule-injectie. */

export function csvVeld(waarde: unknown, scheiding = ";"): string {
  if (waarde === null || waarde === undefined) return "";
  let s = typeof waarde === "object" ? JSON.stringify(waarde) : String(waarde);
  // Voorkom dat Excel/LibreOffice een cel als formule uitvoert.
  if (typeof waarde === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (s.includes(scheiding) || s.includes('"') || s.includes("\n") || s.includes("\r")) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function naarCsv(kolommen: string[], rijen: Record<string, unknown>[], scheiding = ";"): string {
  const regels = [kolommen.map((k) => csvVeld(k, scheiding)).join(scheiding)];
  for (const r of rijen) regels.push(kolommen.map((k) => csvVeld(r[k], scheiding)).join(scheiding));
  // BOM zodat Excel UTF-8 herkent
  return `﻿${regels.join("\r\n")}\r\n`;
}
