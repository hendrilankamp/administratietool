import { test } from "node:test";
import assert from "node:assert/strict";
import { testCtx } from "./helpers.ts";
import { haalTransactie, ontkoppel, slaRekeningOp, transacties } from "../src/modules/bank/service.ts";
import { boekTransactieOpLening, boekingen, haalLening, slaLeningOp, totaalOpenstaand, verwijderBoeking, voegBoekingToe } from "../src/modules/leningen/service.ts";
import { winstEnVerlies } from "../src/modules/rapportages/service.ts";

test("lening privé: stortingen, aflossingen via bank en handmatig, restschuld, ontkoppelen", async () => {
  const ctx = await testCtx();
  try {
    const rek = slaRekeningOp(ctx, null, { naam: "N26", iban: "DE89 3704 0044 0532 0130 00", bank: "N26", beginsaldo: 0, begindatum: "2026-01-01" }, "test");
    const l = slaLeningOp(ctx, { naam: "Lening privé" }, "test");
    voegBoekingToe(ctx, l, { datum: "2026-01-01", omschrijving: "Beginstand", bedrag: 500000 }, "test");
    const ins = (d: string, b: number, fp: string) => ctx.db.run("INSERT INTO banktransacties (rekening_id, boekdatum, bedrag, valuta, tegenpartij_naam, omschrijving, fingerprint) VALUES (?, ?, ?, 'EUR', 'H. Lankamp', 'privé', ?)", [rek, d, b, fp]).id;
    const storting = ins("2026-03-01", 100000, "a");
    const aflossing = ins("2026-06-01", -150000, "b");
    boekTransactieOpLening(ctx, storting, l, "test");
    boekTransactieOpLening(ctx, aflossing, l, "test");
    const lening = haalLening(ctx, l)!;
    assert.equal(lening.geleend, 600000);
    assert.equal(lening.afgelost, 150000);
    assert.equal(lening.openstaand, 450000);
    assert.equal(totaalOpenstaand(ctx), 450000);
    assert.equal(haalTransactie(ctx, aflossing)!.status, "geboekt_zonder_factuur");
    assert.throws(() => boekTransactieOpLening(ctx, aflossing, l, "test"), /al op een lening/);
    // Geen invloed op winst en verlies (neutraal)
    assert.equal(winstEnVerlies(ctx, "2026-01-01", "2026-12-31").totaalKosten, 0);
    // Bankboeking kun je niet handmatig wissen; ontkoppelen haalt hem weg
    const bank = boekingen(ctx, l).find((b) => b.transactie_id === aflossing)!;
    assert.throws(() => verwijderBoeking(ctx, l, bank.id, "test"), /Ontkoppel/);
    ontkoppel(ctx, aflossing, "test");
    assert.equal(haalLening(ctx, l)!.openstaand, 600000);
    assert.equal(transacties(ctx, { status: "open" }).length, 1);
  } finally {
    ctx.opruimen();
  }
});

test("transactie met categorie 'Lening privé' zonder lening: verschijnt als los en kan alsnog aan de lening", async () => {
  const { losseLeningTransacties, LENING_CATEGORIE } = await import("../src/modules/leningen/service.ts");
  const { boekZonderFactuur } = await import("../src/modules/bank/service.ts");
  const ctx = await testCtx();
  try {
    const rek = slaRekeningOp(ctx, null, { naam: "N26", iban: "DE89 3704 0044 0532 0130 00", bank: "N26", beginsaldo: 0, begindatum: "2026-01-01" }, "test");
    const l = slaLeningOp(ctx, { naam: "Lening privé" }, "test");
    const tx = ctx.db.run("INSERT INTO banktransacties (rekening_id, boekdatum, bedrag, valuta, tegenpartij_naam, omschrijving, fingerprint) VALUES (?, '2026-05-01', 200000, 'EUR', 'Ik', 'storting', 'x')", [rek]).id;
    const cat = ctx.db.get<{ id: number }>("SELECT id FROM categorieen WHERE naam = ?", [LENING_CATEGORIE])!.id;
    boekZonderFactuur(ctx, tx, cat, null, "test");
    assert.equal(haalLening(ctx, l)!.openstaand, 0);
    assert.equal(losseLeningTransacties(ctx).length, 1);
    boekTransactieOpLening(ctx, tx, l, "test");
    assert.equal(haalLening(ctx, l)!.openstaand, 200000);
    assert.equal(losseLeningTransacties(ctx).length, 0);
    assert.throws(() => boekTransactieOpLening(ctx, tx, l, "test"), /al op een lening/);
  } finally {
    ctx.opruimen();
  }
});
