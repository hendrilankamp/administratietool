/** Alle bedragen zijn integers in centen. */

/**
 * Parseert een bedrag zoals een mens of bank het schrijft naar centen.
 * Ondersteunt "1.234,56", "1234.56", "-12,5", "€ 10", "1,234.56", "(12.00)".
 * `decimaal` forceert het decimaalteken; anders wordt het geraden.
 */
export function parseBedrag(invoer: string | number | null | undefined, decimaal?: "," | "."): number | null {
  if (invoer === null || invoer === undefined) return null;
  if (typeof invoer === "number") {
    if (!Number.isFinite(invoer)) return null;
    return Math.round(invoer * 100);
  }
  let s = invoer.trim().replace(/[€\s ]|EUR/gi, "");
  if (s === "") return null;
  let negatief = false;
  if (/^\(.*\)$/.test(s)) {
    negatief = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith("-")) {
    negatief = true;
    s = s.slice(0, -1);
  }
  if (s.startsWith("-")) {
    negatief = !negatief;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (!/^[\d.,']+$/.test(s)) return null;

  let dec = decimaal;
  if (!dec) {
    const laatsteKomma = s.lastIndexOf(",");
    const laatstePunt = s.lastIndexOf(".");
    if (laatsteKomma >= 0 && laatstePunt >= 0) dec = laatsteKomma > laatstePunt ? "," : ".";
    else if (laatsteKomma >= 0) dec = s.length - laatsteKomma - 1 === 3 && (s.match(/,/g)?.length ?? 0) > 1 ? "." : ",";
    else if (laatstePunt >= 0) {
      // Nederlandse notatie: "1.234" of "1.234.567" => punt is duizendtalscheiding
      const naPunt = s.length - laatstePunt - 1;
      dec = naPunt === 3 ? "," : ".";
    } else dec = ",";
  }
  const duizend = dec === "," ? /[.']/g : /[,']/g;
  s = s.replace(duizend, "");
  if (dec === ",") s = s.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;

  const [heel, frac = ""] = s.split(".");
  // Afronden op centen (half naar boven, op basis van de 3e decimaal)
  let centen = Number.parseInt(heel, 10) * 100 + Number.parseInt((frac + "00").slice(0, 2), 10);
  if (frac.length > 2 && Number.parseInt(frac[2], 10) >= 5) centen += 1;
  return negatief ? -centen : centen;
}

const fmt = new Intl.NumberFormat("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 123456 -> "1.234,56" */
export function formatBedrag(centen: number | null | undefined): string {
  if (centen === null || centen === undefined) return "";
  return fmt.format(centen / 100);
}

/** 123456 -> "€ 1.234,56" */
export function euro(centen: number | null | undefined): string {
  if (centen === null || centen === undefined) return "";
  return `€ ${formatBedrag(centen)}`;
}

/** Voor invoervelden: 123456 -> "1234,56" */
export function invoerBedrag(centen: number | null | undefined): string {
  if (centen === null || centen === undefined) return "";
  const neg = centen < 0 ? "-" : "";
  const a = Math.abs(centen);
  return `${neg}${Math.floor(a / 100)},${String(a % 100).padStart(2, "0")}`;
}

/** BTW berekenen: bedrag excl. x tarief (basispunten), afgerond op centen (half van nul af). */
export function berekenBtw(bedragExcl: number, tariefBp: number): number {
  const ruw = (bedragExcl * tariefBp) / 10000;
  return Math.sign(ruw) * Math.round(Math.abs(ruw));
}

/** Naar hele euro's naar beneden afronden (zoals in de BTW-aangifte voor grondslagen). */
export function heleEurosOmlaag(centen: number): number {
  return Math.sign(centen) * Math.floor(Math.abs(centen) / 100);
}
