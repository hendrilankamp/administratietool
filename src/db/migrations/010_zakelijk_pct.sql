-- Gemengd gebruik (bv. internet thuis): alleen dit percentage van de inkoopfacturen van de leverancier is zakelijk. NULL = 100%
ALTER TABLE relaties ADD COLUMN zakelijk_pct INTEGER CHECK (zakelijk_pct IS NULL OR (zakelijk_pct >= 1 AND zakelijk_pct <= 100));
