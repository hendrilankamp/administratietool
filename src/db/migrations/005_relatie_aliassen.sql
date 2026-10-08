-- Andere (handels)namen van een relatie, één per regel (bv. oude naam "Akupaneldeal" voor "Paneldeal")
ALTER TABLE relaties ADD COLUMN aliassen TEXT;
