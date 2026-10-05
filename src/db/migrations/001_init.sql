-- Basisschema boekhouding Medialan.
-- Bedragen: INTEGER in centen. Datums: TEXT 'YYYY-MM-DD'. Tijdstippen: TEXT ISO-8601 (UTC).

CREATE TABLE instellingen (
  sleutel TEXT PRIMARY KEY,
  waarde  TEXT NOT NULL
);

CREATE TABLE gebruikers (
  id               INTEGER PRIMARY KEY,
  gebruikersnaam   TEXT NOT NULL UNIQUE,
  wachtwoord_hash  TEXT NOT NULL,
  totp_geheim      TEXT,               -- versleuteld met APP_SECRET
  totp_actief      INTEGER NOT NULL DEFAULT 0,
  aangemaakt_op    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE sessies (
  id              TEXT PRIMARY KEY,    -- sha256 van het cookie-token
  gebruiker_id    INTEGER REFERENCES gebruikers(id) ON DELETE CASCADE,
  fase            TEXT NOT NULL CHECK (fase IN ('2fa','volledig')),
  csrf_token      TEXT NOT NULL,
  flash           TEXT,                -- JSON: eenmalige melding voor de volgende pagina
  aangemaakt_op   TEXT NOT NULL,
  laatst_actief   TEXT NOT NULL
);

CREATE TABLE inlogpogingen (
  id      INTEGER PRIMARY KEY,
  ip      TEXT NOT NULL,
  op      TEXT NOT NULL,
  gelukt  INTEGER NOT NULL
);
CREATE INDEX idx_inlogpogingen_ip ON inlogpogingen(ip, op);

CREATE TABLE btw_codes (
  code             TEXT PRIMARY KEY,
  omschrijving     TEXT NOT NULL,
  tarief_bp        INTEGER NOT NULL,   -- basispunten: 2100 = 21%
  soort            TEXT NOT NULL CHECK (soort IN ('verkoop','inkoop','beide')),
  rubriek_verkoop  TEXT,               -- bv. '1a'
  rubriek_inkoop   TEXT,               -- bv. '4b' (verlegd) of '5b' (voorbelasting)
  verlegd          INTEGER NOT NULL DEFAULT 0,
  volgorde         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE categorieen (
  id                  INTEGER PRIMARY KEY,
  naam                TEXT NOT NULL UNIQUE,
  soort               TEXT NOT NULL CHECK (soort IN ('omzet','kosten','neutraal')),
  standaard_btw_code  TEXT REFERENCES btw_codes(code),
  actief              INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE relaties (
  id                     INTEGER PRIMARY KEY,
  naam                   TEXT NOT NULL,
  type                   TEXT NOT NULL CHECK (type IN ('klant','leverancier','beide')),
  kvk                    TEXT,
  btw_nummer             TEXT,
  iban                   TEXT,
  email                  TEXT,
  adres                  TEXT,
  postcode               TEXT,
  plaats                 TEXT,
  land                   TEXT NOT NULL DEFAULT 'NL',
  standaard_categorie_id INTEGER REFERENCES categorieen(id),
  standaard_btw_code     TEXT REFERENCES btw_codes(code),
  notities               TEXT,
  aangemaakt_op          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  gewijzigd_op           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_relaties_iban ON relaties(iban);
CREATE INDEX idx_relaties_btw ON relaties(btw_nummer);

CREATE TABLE bijlagen (
  sha256         TEXT PRIMARY KEY,
  bestandsnaam   TEXT NOT NULL,
  mime           TEXT NOT NULL,
  grootte        INTEGER NOT NULL,
  aangemaakt_op  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE email_berichten (
  id                   INTEGER PRIMARY KEY,
  graph_id             TEXT NOT NULL,
  internet_message_id  TEXT NOT NULL UNIQUE,
  onderwerp            TEXT,
  afzender             TEXT,
  ontvangen_op         TEXT,
  verwerkt_op          TEXT NOT NULL,
  aantal_bijlagen      INTEGER NOT NULL DEFAULT 0,
  fout                 TEXT
);

CREATE TABLE inkoopfacturen (
  id                INTEGER PRIMARY KEY,
  relatie_id        INTEGER REFERENCES relaties(id),
  factuurnummer     TEXT,
  factuurdatum      TEXT,
  vervaldatum       TEXT,
  omschrijving      TEXT,
  valuta            TEXT NOT NULL DEFAULT 'EUR',
  totaal_excl       INTEGER NOT NULL DEFAULT 0,
  totaal_btw        INTEGER NOT NULL DEFAULT 0,
  totaal_incl       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL CHECK (status IN ('te_beoordelen','geboekt')),
  betaald_handmatig_op TEXT,
  bijlage_sha256    TEXT REFERENCES bijlagen(sha256),
  bron              TEXT NOT NULL CHECK (bron IN ('upload','email','handmatig')),
  email_bericht_id  INTEGER REFERENCES email_berichten(id),
  ai_status         TEXT CHECK (ai_status IN ('wachtrij','bezig','klaar','fout','overgeslagen')),
  ai_voorstel       TEXT,              -- JSON zoals door AI geleverd (audit)
  ai_melding        TEXT,
  geboekt_op        TEXT,
  aangemaakt_op     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  gewijzigd_op      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_inkoop_status ON inkoopfacturen(status);
CREATE INDEX idx_inkoop_datum ON inkoopfacturen(factuurdatum);

CREATE TABLE inkoopfactuur_regels (
  id            INTEGER PRIMARY KEY,
  factuur_id    INTEGER NOT NULL REFERENCES inkoopfacturen(id) ON DELETE CASCADE,
  volgorde      INTEGER NOT NULL DEFAULT 0,
  omschrijving  TEXT,
  categorie_id  INTEGER REFERENCES categorieen(id),
  bedrag_excl   INTEGER NOT NULL,
  btw_code      TEXT NOT NULL REFERENCES btw_codes(code),
  btw_bedrag    INTEGER NOT NULL      -- BTW zoals op de factuur (0 bij verlegd)
);

CREATE TABLE verkoopfacturen (
  id                INTEGER PRIMARY KEY,
  relatie_id        INTEGER REFERENCES relaties(id),
  factuurnummer     TEXT,
  factuurdatum      TEXT,
  vervaldatum       TEXT,
  omschrijving      TEXT,
  valuta            TEXT NOT NULL DEFAULT 'EUR',
  totaal_excl       INTEGER NOT NULL DEFAULT 0,
  totaal_btw        INTEGER NOT NULL DEFAULT 0,
  totaal_incl       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL CHECK (status IN ('concept','geboekt','vervallen')),
  betaald_handmatig_op TEXT,
  bron              TEXT NOT NULL CHECK (bron IN ('mollie','handmatig')),
  mollie_id         TEXT UNIQUE,
  mollie_status     TEXT,
  mollie_betaald_op TEXT,
  mollie_betaalreferenties TEXT,       -- JSON-array van tr_/pl_-id's
  bijlage_sha256    TEXT REFERENCES bijlagen(sha256),
  geboekt_op        TEXT,
  aangemaakt_op     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  gewijzigd_op      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_verkoop_datum ON verkoopfacturen(factuurdatum);

CREATE TABLE verkoopfactuur_regels (
  id            INTEGER PRIMARY KEY,
  factuur_id    INTEGER NOT NULL REFERENCES verkoopfacturen(id) ON DELETE CASCADE,
  volgorde      INTEGER NOT NULL DEFAULT 0,
  omschrijving  TEXT,
  categorie_id  INTEGER REFERENCES categorieen(id),
  bedrag_excl   INTEGER NOT NULL,
  btw_code      TEXT NOT NULL REFERENCES btw_codes(code),
  btw_bedrag    INTEGER NOT NULL
);

CREATE TABLE bankrekeningen (
  id           INTEGER PRIMARY KEY,
  naam         TEXT NOT NULL,
  iban         TEXT NOT NULL UNIQUE,
  bank         TEXT,
  beginsaldo   INTEGER NOT NULL DEFAULT 0,
  begindatum   TEXT NOT NULL
);

CREATE TABLE saldo_controles (
  id            INTEGER PRIMARY KEY,
  rekening_id   INTEGER NOT NULL REFERENCES bankrekeningen(id) ON DELETE CASCADE,
  datum         TEXT NOT NULL,
  saldo         INTEGER NOT NULL,
  aangemaakt_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE csv_profielen (
  id         INTEGER PRIMARY KEY,
  naam       TEXT NOT NULL UNIQUE,
  doel       TEXT NOT NULL CHECK (doel IN ('banktransacties','relaties')),
  config     TEXT NOT NULL,           -- JSON (zie src/modules/csv-import/profiel.ts)
  ingebouwd  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE import_batches (
  id               INTEGER PRIMARY KEY,
  doel             TEXT NOT NULL,
  profiel_naam     TEXT NOT NULL,
  bestandsnaam     TEXT NOT NULL,
  sha256           TEXT NOT NULL,
  rekening_id      INTEGER REFERENCES bankrekeningen(id),
  aantal_nieuw     INTEGER NOT NULL DEFAULT 0,
  aantal_dubbel    INTEGER NOT NULL DEFAULT 0,
  aantal_fout      INTEGER NOT NULL DEFAULT 0,
  aangemaakt_op    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  teruggedraaid_op TEXT
);

CREATE TABLE banktransacties (
  id                INTEGER PRIMARY KEY,
  rekening_id       INTEGER NOT NULL REFERENCES bankrekeningen(id),
  boekdatum         TEXT NOT NULL,
  valutadatum       TEXT,
  bedrag            INTEGER NOT NULL,   -- + bijschrijving, - afschrijving
  valuta            TEXT NOT NULL DEFAULT 'EUR',
  tegenpartij_naam  TEXT,
  tegenpartij_iban  TEXT,
  omschrijving      TEXT,
  type              TEXT,
  import_batch_id   INTEGER REFERENCES import_batches(id),
  fingerprint       TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','gekoppeld','geboekt_zonder_factuur')),
  categorie_id      INTEGER REFERENCES categorieen(id),  -- alleen bij 'geboekt_zonder_factuur'
  notitie           TEXT,
  aangemaakt_op     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_banktx_status ON banktransacties(status, boekdatum);
CREATE INDEX idx_banktx_rekening ON banktransacties(rekening_id, boekdatum);

-- Bedrag met teken vanuit de bank gezien: verkoop (ontvangst) positief, inkoop (betaling) negatief.
-- Som van koppelingen van een transactie = transactiebedrag => volledig afgeletterd.
CREATE TABLE transactie_koppelingen (
  id                 INTEGER PRIMARY KEY,
  transactie_id      INTEGER NOT NULL REFERENCES banktransacties(id) ON DELETE CASCADE,
  inkoopfactuur_id   INTEGER REFERENCES inkoopfacturen(id),
  verkoopfactuur_id  INTEGER REFERENCES verkoopfacturen(id),
  bedrag             INTEGER NOT NULL,
  automatisch        INTEGER NOT NULL DEFAULT 0,
  aangemaakt_op      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK ((inkoopfactuur_id IS NULL) <> (verkoopfactuur_id IS NULL))
);
CREATE INDEX idx_koppeling_tx ON transactie_koppelingen(transactie_id);
CREATE INDEX idx_koppeling_inkoop ON transactie_koppelingen(inkoopfactuur_id);
CREATE INDEX idx_koppeling_verkoop ON transactie_koppelingen(verkoopfactuur_id);

CREATE TABLE mollie_uitbetalingen (
  id              INTEGER PRIMARY KEY,
  mollie_id       TEXT NOT NULL UNIQUE,
  referentie      TEXT,
  status          TEXT,
  bedrag          INTEGER NOT NULL,
  kosten          INTEGER NOT NULL DEFAULT 0,   -- ingehouden Mollie-kosten (bruto)
  mollie_factuur_id TEXT,                       -- Mollie's eigen factuur voor de kosten
  uitbetaald_op   TEXT,
  aangemaakt_op   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE mollie_uitbetaling_facturen (
  uitbetaling_id    INTEGER NOT NULL REFERENCES mollie_uitbetalingen(id) ON DELETE CASCADE,
  verkoopfactuur_id INTEGER NOT NULL REFERENCES verkoopfacturen(id),
  bedrag            INTEGER NOT NULL,
  PRIMARY KEY (uitbetaling_id, verkoopfactuur_id)
);

CREATE TABLE bankregels (
  id            INTEGER PRIMARY KEY,
  naam          TEXT NOT NULL,
  veld          TEXT NOT NULL CHECK (veld IN ('tegenpartij','omschrijving','iban')),
  bevat         TEXT NOT NULL,
  categorie_id  INTEGER REFERENCES categorieen(id),
  relatie_id    INTEGER REFERENCES relaties(id),
  actief        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE perioden (
  id                      TEXT PRIMARY KEY,      -- '2026-Q4'
  jaar                    INTEGER NOT NULL,
  kwartaal                INTEGER NOT NULL CHECK (kwartaal BETWEEN 1 AND 4),
  status                  TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','afgesloten')),
  afgesloten_op           TEXT,
  correctie_1d_grondslag  INTEGER NOT NULL DEFAULT 0,
  correctie_1d_btw        INTEGER NOT NULL DEFAULT 0,
  notitie                 TEXT
);

CREATE TABLE taak_status (
  naam             TEXT PRIMARY KEY,
  laatst_gestart   TEXT,
  laatst_gelukt    TEXT,
  laatste_fout     TEXT,
  melding          TEXT
);

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  op           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  gebruiker    TEXT,
  actie        TEXT NOT NULL,
  entiteit     TEXT,
  entiteit_id  TEXT,
  details      TEXT
);
CREATE INDEX idx_audit_entiteit ON audit_log(entiteit, entiteit_id);

-- Betaalde bedragen per factuur via bankkoppelingen (inkoop: afschrijving = negatief bedrag).
CREATE VIEW v_inkoop_betaald AS
  SELECT f.id AS factuur_id, COALESCE(-SUM(k.bedrag), 0) AS betaald_bank
  FROM inkoopfacturen f LEFT JOIN transactie_koppelingen k ON k.inkoopfactuur_id = f.id
  GROUP BY f.id;

CREATE VIEW v_verkoop_ontvangen AS
  SELECT f.id AS factuur_id, COALESCE(SUM(k.bedrag), 0) AS ontvangen_bank
  FROM verkoopfacturen f LEFT JOIN transactie_koppelingen k ON k.verkoopfactuur_id = f.id
  GROUP BY f.id;

-- Standaard BTW-codes (rubrieken BTW-aangifte NL)
INSERT INTO btw_codes (code, omschrijving, tarief_bp, soort, rubriek_verkoop, rubriek_inkoop, verlegd, volgorde) VALUES
  ('NL21',              'BTW 21%',                                  2100, 'beide',   '1a', '5b', 0, 1),
  ('NL9',               'BTW 9%',                                   900,  'beide',   '1b', '5b', 0, 2),
  ('NL0',               'BTW 0% / niet bij u belast',               0,    'beide',   '1e', NULL, 0, 3),
  ('GEEN',              'Geen BTW (vrijgesteld / buiten BTW)',      0,    'beide',   NULL, NULL, 0, 4),
  ('VERLEGD_NL',        'BTW verlegd (binnenland)',                 2100, 'beide',   '1e', '2a', 1, 5),
  ('EU_DIENST',         'EU – dienst (verlegd)',                    2100, 'beide',   '3b', '4b', 1, 6),
  ('EU_GOED',           'EU – goederen (ICP / verwerving)',         2100, 'beide',   '3b', '4b', 1, 7),
  ('BUITEN_EU',         'Buiten EU (export / dienst uit buitenland)', 2100, 'beide', '3a', '4a', 1, 8);

-- Standaard categorieën
INSERT INTO categorieen (naam, soort, standaard_btw_code) VALUES
  ('Omzet',                       'omzet',    'NL21'),
  ('Inkoop / uitbesteed werk',    'kosten',   'NL21'),
  ('Software & abonnementen',     'kosten',   'NL21'),
  ('Advertentiekosten',           'kosten',   'EU_DIENST'),
  ('Kantoorkosten',               'kosten',   'NL21'),
  ('Telefoon & internet',         'kosten',   'NL21'),
  ('Autokosten',                  'kosten',   'NL21'),
  ('Reis- en verblijfkosten',     'kosten',   'NL9'),
  ('Opleiding',                   'kosten',   'NL21'),
  ('Huisvesting',                 'kosten',   'NL21'),
  ('Bankkosten',                  'kosten',   'GEEN'),
  ('Betaalproviderkosten (Mollie)', 'kosten', 'NL21'),
  ('Verzekeringen',               'kosten',   'GEEN'),
  ('Investeringen (> € 450)',     'kosten',   'NL21'),
  ('Overige kosten',              'kosten',   'NL21'),
  ('Privé',                       'neutraal', 'GEEN'),
  ('Belastingen (BTW / IB)',      'neutraal', 'GEEN'),
  ('Overboeking eigen rekening',  'neutraal', 'GEEN');
