import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { testCtx, categorieId } from "./helpers.ts";
import { maakBackup, verifieerZip, ontsleutelBestand } from "../src/backup/maak.ts";
import { bereidHerstelVoor, testHerstel, voerHerstelUitBijStart, vergelijkMetManifest } from "../src/backup/herstel.ts";
import { leesZip } from "../src/backup/zip.ts";
import { bewaarBijlage } from "../src/lib/bijlagen.ts";
import { nieuweInkoopfactuur, werkFactuurBij } from "../src/modules/facturen/service.ts";
import { slaRelatieOp } from "../src/modules/relaties/service.ts";
import { Db } from "../src/db/index.ts";
import { hashWachtwoord } from "../src/lib/crypto.ts";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

async function vulDemo(ctx: Awaited<ReturnType<typeof testCtx>>) {
  ctx.db.run("INSERT INTO gebruikers (gebruikersnaam, wachtwoord_hash) VALUES ('hendri', ?)", [hashWachtwoord("x")]);
  const rel = slaRelatieOp(ctx, null, { naam: "Leverancier; \"Test\" B.V.", type: "leverancier", iban: "NL91 ABNA 0417 1643 00" }, "test");
  const b = bewaarBijlage(ctx, PDF, "factuur.pdf");
  const id = nieuweInkoopfactuur(ctx, "upload", { bijlage: b.sha256, gebruiker: "test" });
  werkFactuurBij(
    ctx,
    "inkoop",
    id,
    {
      relatie_id: rel,
      factuurnummer: "F-001",
      factuurdatum: "2026-10-01",
      regels: [{ omschrijving: "=CMD|' /C calc'!A0", categorie_id: categorieId(ctx, "Kantoorkosten"), bedrag_excl: 10000, btw_code: "NL21" }],
    },
    { gebruiker: "test", boeken: true },
  );
}

test("backup bevat manifest, JSON, CSV, schema, bijlagen en snapshot en is verifieerbaar", async () => {
  const ctx = await testCtx();
  try {
    await vulDemo(ctx);
    const r = await maakBackup(ctx, "test");
    assert.ok(fs.existsSync(r.bestand));
    const m = await verifieerZip(r.bestand);
    assert.equal(m.tabellen.inkoopfacturen, 1);
    assert.equal(m.controletotalen.inkoop_totaal_incl, 12100);
    assert.ok(m.bestanden["data/relaties.json"]);
    assert.ok(m.bestanden["csv/inkoopfactuur_regels.csv"]);
    assert.ok(m.bestanden["schema/relaties.schema.json"]);
    assert.ok(m.bestanden["database.sqlite"]);
    assert.equal(Object.keys(m.bestanden).filter((b) => b.startsWith("attachments/")).length, 1);
    assert.ok(!m.bestanden["data/sessies.json"], "sessies horen niet in de export");

    const { inhoud } = await leesZip(r.bestand, () => "geheugen");
    const gebruikers = JSON.parse(inhoud.get("data/gebruikers.json")!.toString());
    assert.equal(gebruikers[0].wachtwoord_hash, undefined, "wachtwoord-hash mag niet in JSON");
    const csv = inhoud.get("csv/inkoopfactuur_regels.csv")!.toString();
    assert.ok(csv.includes("'=CMD"), "formule-injectie moet geneutraliseerd zijn");

    // Manipulatie wordt gedetecteerd
    const kapot = path.join(ctx.dir, "kapot.zip");
    const buf = fs.readFileSync(r.bestand);
    const i = buf.indexOf(Buffer.from("%PDF-1.4"));
    buf[i + 5] = "9".charCodeAt(0);
    fs.writeFileSync(kapot, buf);
    await assert.rejects(verifieerZip(kapot));
  } finally {
    ctx.opruimen();
  }
});

test("versleutelde externe kopie is met age te ontsleutelen", async () => {
  const ctx = await testCtx();
  try {
    ctx.config.BACKUP_EXTERN_DIR = path.join(ctx.dir, "extern");
    ctx.config.AGE_PASSPHRASE = "correct horse battery staple";
    await vulDemo(ctx);
    const r = await maakBackup(ctx, "test");
    assert.ok(r.extern && fs.existsSync(r.extern));
    assert.notEqual(fs.readFileSync(r.extern).subarray(0, 2).toString(), "PK");
    const terug = path.join(ctx.dir, "terug.zip");
    await ontsleutelBestand(r.extern!, terug, { passphrase: "correct horse battery staple" });
    assert.deepEqual(fs.readFileSync(terug), fs.readFileSync(r.bestand));
    await assert.rejects(ontsleutelBestand(r.extern!, path.join(ctx.dir, "x.zip"), { passphrase: "fout" }));
  } finally {
    ctx.opruimen();
  }
});

test("herstel via SQLite-snapshot en via alleen JSON levert dezelfde data op", async () => {
  const ctx = await testCtx();
  try {
    await vulDemo(ctx);
    const r = await maakBackup(ctx, "test");
    assert.match(await testHerstel(ctx.config), /OK/);

    for (const forceerJson of [false, true]) {
      const { manifest, modus } = await bereidHerstelVoor(ctx.config, r.bestand, { forceerJson });
      assert.equal(modus, forceerJson ? "json" : "sqlite");
      // Wijzig de live database; na herstel moet de wijziging weg zijn.
      ctx.db.run("DELETE FROM inkoopfactuur_regels");
      ctx.db.close();
      fs.rmSync(ctx.config.bijlagenDir, { recursive: true, force: true });
      assert.ok(voerHerstelUitBijStart(ctx.config, ctx.log));
      const fouten = vergelijkMetManifest(ctx.config.dbPad, manifest, { negeerTabellen: forceerJson ? ["gebruikers", "schema_migraties"] : [] });
      assert.deepEqual(fouten, []);
      assert.equal(fs.readdirSync(ctx.config.bijlagenDir).length, 1, "bijlage moet terug zijn");
      (ctx as { db: Db }).db = new Db(ctx.config.dbPad);
    }
  } finally {
    ctx.opruimen();
  }
});
