/** Datums worden opgeslagen als 'YYYY-MM-DD' (lokale kalenderdatum). */

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isGeldigeDatum(s: string | null | undefined): s is string {
  if (!s) return false;
  const m = ISO.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export type DatumFormaat = "YYYY-MM-DD" | "DD-MM-YYYY" | "DD/MM/YYYY" | "DD.MM.YYYY" | "MM/DD/YYYY" | "YYYYMMDD";

/** Parseert een datum in het opgegeven formaat naar 'YYYY-MM-DD', of null. */
export function parseDatum(invoer: string | null | undefined, formaat: DatumFormaat = "YYYY-MM-DD"): string | null {
  if (!invoer) return null;
  const s = invoer.trim().slice(0, 10);
  let j: string, m: string, d: string;
  let r: RegExpExecArray | null;
  switch (formaat) {
    case "YYYY-MM-DD":
      r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(invoer.trim());
      if (!r) return null;
      [, j, m, d] = r;
      break;
    case "DD-MM-YYYY":
    case "DD/MM/YYYY":
    case "DD.MM.YYYY":
      r = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
      if (!r) return null;
      [, d, m, j] = r;
      break;
    case "MM/DD/YYYY":
      r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
      if (!r) return null;
      [, m, d, j] = r;
      break;
    case "YYYYMMDD":
      r = /^(\d{4})(\d{2})(\d{2})$/.exec(invoer.trim());
      if (!r) return null;
      [, j, m, d] = r;
      break;
  }
  const iso = `${j}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return isGeldigeDatum(iso) ? iso : null;
}

/** Vandaag als 'YYYY-MM-DD' in de tijdzone van het proces (TZ=Europe/Amsterdam in de container). */
export function vandaag(nu: Date = new Date()): string {
  const j = nu.getFullYear();
  const m = String(nu.getMonth() + 1).padStart(2, "0");
  const d = String(nu.getDate()).padStart(2, "0");
  return `${j}-${m}-${d}`;
}

export function kwartaalVan(datum: string): { jaar: number; kwartaal: number; id: string } {
  const jaar = Number(datum.slice(0, 4));
  const kwartaal = Math.floor((Number(datum.slice(5, 7)) - 1) / 3) + 1;
  return { jaar, kwartaal, id: `${jaar}-Q${kwartaal}` };
}

export function kwartaalGrenzen(jaar: number, kwartaal: number): { van: string; tot: string } {
  const startMaand = (kwartaal - 1) * 3 + 1;
  const eindMaand = startMaand + 2;
  const laatsteDag = new Date(Date.UTC(jaar, eindMaand, 0)).getUTCDate();
  return {
    van: `${jaar}-${String(startMaand).padStart(2, "0")}-01`,
    tot: `${jaar}-${String(eindMaand).padStart(2, "0")}-${laatsteDag}`,
  };
}

export function parseKwartaalId(id: string): { jaar: number; kwartaal: number } | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(id);
  return m ? { jaar: Number(m[1]), kwartaal: Number(m[2]) } : null;
}

export function dagenVerschil(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export function nlDatum(iso: string | null | undefined): string {
  if (!iso || !isGeldigeDatum(iso.slice(0, 10))) return iso ?? "";
  const [j, m, d] = iso.slice(0, 10).split("-");
  return `${d}-${m}-${j}`;
}

export function nlTijdstip(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" });
}

/** Aantal dagen van a t/m b (inclusief). */
function dagenIncl(a: string, b: string): number {
  return dagenVerschil(a, b) + 1;
}

/**
 * Welk deel (0..1) van de periode [pVan, pTot] valt binnen [van, tot]? Grenzen inclusief.
 * Gebruikt om bedragen van bv. een jaarfactuur naar rato over kwartalen te verdelen.
 */
export function overlapFractie(van: string, tot: string, pVan: string, pTot: string): number {
  if (pTot < pVan) return 0;
  const begin = pVan > van ? pVan : van;
  const eind = pTot < tot ? pTot : tot;
  if (eind < begin) return 0;
  return dagenIncl(begin, eind) / dagenIncl(pVan, pTot);
}

const laatsteDag = (j: number, m: number) => new Date(Date.UTC(j, m, 0)).getUTCDate();
const pad2 = (n: number | string) => String(n).padStart(2, "0");

/** "2026-03" → { van: 2026-03-01, tot: 2026-03-31 } */
export function maandGrenzen(jjjjmm: string): { van: string; tot: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(jjjjmm);
  if (!m || +m[2] < 1 || +m[2] > 12) return null;
  return { van: `${m[1]}-${m[2]}-01`, tot: `${m[1]}-${m[2]}-${pad2(laatsteDag(+m[1], +m[2]))}` };
}

const MAANDEN: Record<string, number> = {
  jan: 1, januari: 1, january: 1, feb: 2, februari: 2, february: 2, mrt: 3, maart: 3, mar: 3, march: 3, apr: 4, april: 4, mei: 5, may: 5,
  jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, aug: 8, augustus: 8, august: 8, sep: 9, sept: 9, september: 9, okt: 10, oktober: 10,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/**
 * Leest een periode zoals die op facturen staat:
 * "01.09.2026 tot 01.10.2026", "01-01-2026 t/m 31-12-2026", "02-2021 T/M 12-2021", "september 2026", "2026-01-01 - 2026-12-31".
 * Een einddatum die precies op de 1e van de maand na een hele periode valt ("01.09 tot 01.10") wordt de laatste dag ervoor.
 */
export function parsePeriode(tekst: string | null | undefined): { van: string; tot: string } | null {
  if (!tekst) return null;
  const t = tekst.toLowerCase().trim();
  const datum = String.raw`(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})|(\d{4})-(\d{2})-(\d{2})`;
  const scheiding = String.raw`\s*(?:tot en met|t\/m|tm|tot|until|to|-|–|—)\s*`;
  const naarIso = (m: string[], i: number) => (m[i] ? `${m[i + 2]}-${pad2(m[i + 1])}-${pad2(m[i])}` : `${m[i + 3]}-${m[i + 4]}-${m[i + 5]}`);
  const dd = new RegExp(`(?:${datum})${scheiding}(?:${datum})`).exec(t);
  if (dd) {
    const van = naarIso(dd, 1);
    let tot = naarIso(dd, 7);
    const exclusief = /\btot\b|until|\bto\b/.test(t) && !/t\/m|tot en met/.test(t);
    // "01.09.2026 tot 01.10.2026": einde is exclusief → 30-09-2026
    if (exclusief && tot.endsWith("-01") && tot > van) {
      const d = new Date(`${tot}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      tot = d.toISOString().slice(0, 10);
    }
    return isGeldigeDatum(van) && isGeldigeDatum(tot) && tot >= van ? { van, tot } : null;
  }
  const mm = new RegExp(String.raw`(\d{1,2})[\-/](\d{4})${scheiding}(\d{1,2})[\-/](\d{4})`).exec(t);
  if (mm) {
    const a = maandGrenzen(`${mm[2]}-${pad2(mm[1])}`);
    const b = maandGrenzen(`${mm[4]}-${pad2(mm[3])}`);
    return a && b && b.tot >= a.van ? { van: a.van, tot: b.tot } : null;
  }
  const mn = /\b([a-z]+)\s+(\d{4})\b/.exec(t);
  if (mn && MAANDEN[mn[1]]) return maandGrenzen(`${mn[2]}-${pad2(MAANDEN[mn[1]])}`);
  return null;
}
