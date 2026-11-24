import { test } from "node:test";
import assert from "node:assert/strict";
import { testCtx } from "./helpers.ts";
import { laatsteTarief, ritTotaal, ritten, slaRitOp, verwijderRit } from "../src/modules/ritten/service.ts";
import { winstEnVerlies } from "../src/modules/rapportages/service.ts";

test("ritten: retour verdubbelt km, vergoeding = km x tarief en telt als kosten in winst & verlies", async () => {
  const ctx = await testCtx();
  try {
    assert.equal(laatsteTarief(ctx), 25);
    const basis = { van: "Hoofddorp", naar: "Utrecht", doel: "Overleg klant", tarief_ct: 23 };
    const id = slaRitOp(ctx, { ...basis, datum: "2026-03-10", kilometers: 50, retour: true }, "test"); // 100 km
    slaRitOp(ctx, { ...basis, datum: "2026-05-02", kilometers: 30, retour: false }, "test");
    const q1 = ritten(ctx, "2026-01-01", "2026-03-31");
    assert.equal(q1.length, 1);
    assert.equal(q1[0].kilometers, 100);
    assert.equal(q1[0].bedrag, 2300);
    const jaar = ritTotaal(ctx, "2026-01-01", "2026-12-31");
    assert.equal(jaar.kilometers, 130);
    assert.equal(jaar.bedrag, 2990);
    assert.equal(jaar.aantal, 2);
    const wv = winstEnVerlies(ctx, "2026-01-01", "2026-12-31");
    assert.equal(wv.totaalKosten, 2990);
    assert.equal(winstEnVerlies(ctx, "2026-04-01", "2026-06-30").totaalKosten, 690);
    assert.throws(() => slaRitOp(ctx, { ...basis, datum: "2026-13-40", kilometers: 5, retour: false }, "test"));
    verwijderRit(ctx, id, "test");
    assert.equal(ritTotaal(ctx, "2026-01-01", "2026-12-31").aantal, 1);
  } finally {
    ctx.opruimen();
  }
});
