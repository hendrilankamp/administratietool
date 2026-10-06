-- Verbruik van de AI (Claude) per verzoek, voor kostenoverzicht en maandlimiet.
CREATE TABLE ai_gebruik (
  id               INTEGER PRIMARY KEY,
  op               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  factuur_id       INTEGER,
  model            TEXT NOT NULL,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  kosten_micro_usd INTEGER NOT NULL DEFAULT 0,   -- geschatte kosten in miljoenste dollar
  gelukt           INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_ai_gebruik_op ON ai_gebruik(op);

-- Standaardmodel wordt Sonnet 5.5 (goedkoper dan Opus, ruim voldoende voor factuuruitlezen)
UPDATE instellingen SET waarde = '"claude-sonnet-5-5"' WHERE sleutel = 'koppeling.AI_MODEL' AND waarde = '"claude-opus-5-5"';
