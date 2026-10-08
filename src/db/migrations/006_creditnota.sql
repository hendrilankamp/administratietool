-- Creditnota's (Mollie levert ze met positieve bedragen en nummer C-...) en lokaal geannuleerde Mollie-facturen
ALTER TABLE verkoopfacturen ADD COLUMN is_creditnota INTEGER NOT NULL DEFAULT 0;
ALTER TABLE verkoopfacturen ADD COLUMN creditnota_voor INTEGER REFERENCES verkoopfacturen(id);
ALTER TABLE verkoopfacturen ADD COLUMN lokaal_geannuleerd INTEGER NOT NULL DEFAULT 0;
