-- Leningen van de eigenaar (privé) aan de zaak: stortingen verhogen de schuld, aflossingen verlagen hem
CREATE TABLE leningen (
  id            INTEGER PRIMARY KEY,
  naam          TEXT NOT NULL,
  startdatum    TEXT,
  rente_pct     REAL,                              -- alleen ter informatie
  notitie       TEXT,
  afgesloten    INTEGER NOT NULL DEFAULT 0,
  aangemaakt_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE lening_boekingen (
  id            INTEGER PRIMARY KEY,
  lening_id     INTEGER NOT NULL REFERENCES leningen(id) ON DELETE CASCADE,
  datum         TEXT NOT NULL,
  omschrijving  TEXT,
  bedrag        INTEGER NOT NULL CHECK (bedrag <> 0),   -- + = geleend (schuld stijgt), - = afgelost
  transactie_id INTEGER REFERENCES banktransacties(id) ON DELETE CASCADE,  -- NULL = handmatige boeking
  aangemaakt_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_lening_boekingen_lening ON lening_boekingen(lening_id);
CREATE UNIQUE INDEX idx_lening_boekingen_transactie ON lening_boekingen(transactie_id) WHERE transactie_id IS NOT NULL;

INSERT INTO categorieen (naam, soort, standaard_btw_code) VALUES ('Lening privé (aan de zaak)', 'neutraal', 'GEEN');
