import type { DatumFormaat } from "../../lib/datum.ts";

export type Doel = "banktransacties" | "relaties";

export const BANK_VELDEN = ["boekdatum", "valutadatum", "bedrag", "bij", "af", "af_bij", "tegenpartij_naam", "tegenpartij_iban", "omschrijving", "type", "valuta"] as const;
export const RELATIE_VELDEN = ["naam", "type", "email", "iban", "btw_nummer", "kvk", "adres", "postcode", "plaats", "land"] as const;
export type Veld = (typeof BANK_VELDEN)[number] | (typeof RELATIE_VELDEN)[number];

export const VELD_LABEL: Record<Veld, string> = {
  boekdatum: "Boekdatum",
  valutadatum: "Valutadatum",
  bedrag: "Bedrag (+/−)",
  bij: "Bedrag bij",
  af: "Bedrag af",
  af_bij: "Af/Bij-indicator",
  tegenpartij_naam: "Naam tegenpartij",
  tegenpartij_iban: "IBAN tegenpartij",
  omschrijving: "Omschrijving / kenmerk",
  type: "Type transactie",
  valuta: "Valuta",
  naam: "Naam",
  email: "E-mail",
  iban: "IBAN",
  btw_nummer: "BTW-nummer",
  kvk: "KvK-nummer",
  adres: "Adres",
  postcode: "Postcode",
  plaats: "Plaats",
  land: "Land",
};

export interface ProfielConfig {
  doel: Doel;
  scheiding?: "," | ";" | "\t"; // leeg = automatisch
  decimaal: "," | ".";
  datumFormaat: DatumFormaat;
  /** veld -> kolomkop(pen); meerdere kolommen worden met een spatie samengevoegd (bv. omschrijving). */
  kolommen: Partial<Record<Veld, string[]>>;
  bedragModus: "een_kolom" | "bij_af" | "indicator";
  /** Bij bedragModus "indicator": waarde in kolom af_bij die een afschrijving aangeeft (bv. "Af"). */
  afWaarde?: string;
  /** Kolomkoppen die (allemaal) aanwezig moeten zijn om dit profiel automatisch te herkennen. */
  herkenning: string[];
}

export interface Profiel {
  id?: number;
  naam: string;
  config: ProfielConfig;
  ingebouwd: boolean;
}

/**
 * Ingebouwde profielen. N26 kent twee exportformaten (nieuw sinds 2023/2024 en het oudere).
 * Controleer bij twijfel met een eigen export; afwijkende kolommen kun je in de wizard koppelen en als nieuw profiel opslaan.
 */
export const INGEBOUWDE_PROFIELEN: Profiel[] = [
  {
    naam: "N26",
    ingebouwd: true,
    config: {
      doel: "banktransacties",
      decimaal: ".",
      datumFormaat: "YYYY-MM-DD",
      bedragModus: "een_kolom",
      kolommen: {
        boekdatum: ["Booking Date"],
        valutadatum: ["Value Date"],
        bedrag: ["Amount (EUR)"],
        tegenpartij_naam: ["Partner Name"],
        tegenpartij_iban: ["Partner Iban"],
        omschrijving: ["Payment Reference"],
        type: ["Type"],
      },
      herkenning: ["Booking Date", "Partner Name", "Amount (EUR)"],
    },
  },
  {
    naam: "N26 (oud formaat)",
    ingebouwd: true,
    config: {
      doel: "banktransacties",
      decimaal: ".",
      datumFormaat: "YYYY-MM-DD",
      bedragModus: "een_kolom",
      kolommen: {
        boekdatum: ["Date"],
        bedrag: ["Amount (EUR)"],
        tegenpartij_naam: ["Payee"],
        tegenpartij_iban: ["Account number"],
        omschrijving: ["Payment reference"],
        type: ["Transaction type"],
      },
      herkenning: ["Date", "Payee", "Account number", "Amount (EUR)"],
    },
  },
  {
    naam: "ING (CSV, puntkomma)",
    ingebouwd: true,
    config: {
      doel: "banktransacties",
      decimaal: ",",
      datumFormaat: "YYYYMMDD",
      bedragModus: "indicator",
      afWaarde: "Af",
      kolommen: {
        boekdatum: ["Datum"],
        bedrag: ["Bedrag (EUR)"],
        af_bij: ["Af Bij"],
        tegenpartij_naam: ["Naam / Omschrijving"],
        tegenpartij_iban: ["Tegenrekening"],
        omschrijving: ["Mededelingen"],
        type: ["Mutatiesoort"],
      },
      herkenning: ["Naam / Omschrijving", "Tegenrekening", "Af Bij", "Bedrag (EUR)"],
    },
  },
  {
    naam: "Rabobank (CSV)",
    ingebouwd: true,
    config: {
      doel: "banktransacties",
      decimaal: ",",
      datumFormaat: "YYYY-MM-DD",
      bedragModus: "een_kolom",
      kolommen: {
        boekdatum: ["Datum"],
        valutadatum: ["Rentedatum"],
        bedrag: ["Bedrag"],
        tegenpartij_naam: ["Naam tegenpartij"],
        tegenpartij_iban: ["Tegenrekening IBAN/BBAN"],
        omschrijving: ["Omschrijving-1", "Omschrijving-2", "Omschrijving-3"],
        valuta: ["Munt"],
      },
      herkenning: ["IBAN/BBAN", "Volgnr", "Naam tegenpartij", "Omschrijving-1"],
    },
  },
  {
    naam: "Relaties (algemeen)",
    ingebouwd: true,
    config: {
      doel: "relaties",
      decimaal: ",",
      datumFormaat: "YYYY-MM-DD",
      bedragModus: "een_kolom",
      kolommen: {
        naam: ["Naam"],
        type: ["Type"],
        email: ["E-mail"],
        iban: ["IBAN"],
        btw_nummer: ["BTW-nummer"],
        kvk: ["KvK"],
        adres: ["Adres"],
        postcode: ["Postcode"],
        plaats: ["Plaats"],
        land: ["Land"],
      },
      herkenning: ["Naam", "E-mail"],
    },
  },
];
