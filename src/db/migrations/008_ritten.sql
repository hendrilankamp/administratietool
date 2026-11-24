-- Ritregistratie privéauto: zakelijke kilometers x tarief (zonder BTW) als aftrekbare kosten
CREATE TABLE ritten (
  id            INTEGER PRIMARY KEY,
  datum         TEXT NOT NULL,
  van           TEXT NOT NULL,
  naar          TEXT NOT NULL,
  doel          TEXT NOT NULL,
  relatie_id    INTEGER REFERENCES relaties(id),
  retour        INTEGER NOT NULL DEFAULT 0,       -- 1 = heen en terug (kilometers is dan al het totaal)
  kilometers    INTEGER NOT NULL CHECK (kilometers > 0),
  tarief_ct     INTEGER NOT NULL CHECK (tarief_ct >= 0),   -- cent per km, vastgelegd per rit
  aangemaakt_op TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_ritten_datum ON ritten(datum);
