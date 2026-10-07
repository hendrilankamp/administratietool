-- Doorbelasting: inkoopregels die voor een klant worden ingekocht (bv. licenties per klant)
ALTER TABLE inkoopfactuur_regels ADD COLUMN doorbelast_relatie_id INTEGER REFERENCES relaties(id);
ALTER TABLE inkoopfactuur_regels ADD COLUMN doorbelast_naam TEXT;   -- naam zoals op de factuur (kopje), voor herkenning
ALTER TABLE inkoopfactuur_regels ADD COLUMN periode TEXT;           -- bv. "01.09.2026 tot 01.10.2026"
CREATE INDEX idx_inkoopregel_doorbelast ON inkoopfactuur_regels(doorbelast_relatie_id);
