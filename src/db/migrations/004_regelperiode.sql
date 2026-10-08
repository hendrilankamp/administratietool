-- Periode waarop een factuurregel betrekking heeft (bv. jaarabonnement), voor verdeling naar rato in rapportages.
ALTER TABLE inkoopfactuur_regels ADD COLUMN periode_van TEXT;
ALTER TABLE inkoopfactuur_regels ADD COLUMN periode_tot TEXT;
ALTER TABLE verkoopfactuur_regels ADD COLUMN periode_van TEXT;
ALTER TABLE verkoopfactuur_regels ADD COLUMN periode_tot TEXT;
