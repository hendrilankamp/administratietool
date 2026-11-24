-- Inkoopfacturen in vreemde valuta: bedragen op de regels staan in euro's; het origineel en de koers worden bewaard
ALTER TABLE inkoopfacturen ADD COLUMN bedrag_valuta INTEGER;  -- totaal incl. BTW in de factuurvaluta (centen)
ALTER TABLE inkoopfacturen ADD COLUMN wisselkoers REAL;       -- euro's per 1 eenheid factuurvaluta; NULL = nog niet omgerekend
-- Zelfde kolommen bij verkoop, zodat de gedeelde opslagcode voor beide soorten werkt (verkoop gebruikt ze niet)
ALTER TABLE verkoopfacturen ADD COLUMN bedrag_valuta INTEGER;
ALTER TABLE verkoopfacturen ADD COLUMN wisselkoers REAL;
