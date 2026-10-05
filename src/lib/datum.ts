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
