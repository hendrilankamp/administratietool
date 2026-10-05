import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testCtx } from "./helpers.ts";
import { laadConfig } from "../src/config.ts";
import { bronVan, pasInstellingenToe, slaInstellingenOp } from "../src/lib/instellingen.ts";

test("APP_SECRET wordt automatisch aangemaakt en hergebruikt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  try {
    const a = laadConfig({ DATA_DIR: dir });
    assert.ok(a.appSecretAutomatisch);
    assert.ok(a.APP_SECRET.length >= 32);
    assert.equal((fs.statSync(path.join(dir, "app-secret")).mode & 0o777).toString(8), "600");
    const b = laadConfig({ DATA_DIR: dir });
    assert.equal(b.APP_SECRET, a.APP_SECRET);
    const c = laadConfig({ DATA_DIR: dir, APP_SECRET: "x".repeat(40) });
    assert.equal(c.APP_SECRET, "x".repeat(40));
    assert.ok(!c.appSecretAutomatisch);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("instellingen: versleuteld opgeslagen, gaan vóór op omgeving, wissen valt terug", async () => {
  const ctx = await testCtx({ MOLLIE_TOKEN: "test_uitOmgeving123456", BACKUP_UUR: "4" });
  try {
    pasInstellingenToe(ctx);
    assert.equal(ctx.config.MOLLIE_TOKEN, "test_uitOmgeving123456");
    assert.equal(bronVan(ctx, "MOLLIE_TOKEN"), "omgeving");

    slaInstellingenOp(ctx, [{ sleutel: "MOLLIE_TOKEN", waarde: "access_uitDeApp1234567890" }, { sleutel: "BACKUP_UUR", waarde: 2 }], "t");
    assert.equal(ctx.config.MOLLIE_TOKEN, "access_uitDeApp1234567890");
    assert.equal(ctx.config.BACKUP_UUR, 2);
    assert.equal(bronVan(ctx, "MOLLIE_TOKEN"), "app");
    const ruw = ctx.db.get<{ waarde: string }>("SELECT waarde FROM instellingen WHERE sleutel = 'koppeling.MOLLIE_TOKEN'")!.waarde;
    assert.ok(!ruw.includes("uitDeApp"), "geheim moet versleuteld zijn");
    assert.ok(!JSON.stringify(ctx.db.all("SELECT * FROM audit_log")).includes("uitDeApp"), "geheim mag niet in het audit-log");

    // Ongewijzigd laten (undefined) en wissen (null)
    slaInstellingenOp(ctx, [{ sleutel: "MOLLIE_TOKEN", waarde: undefined }], "t");
    assert.equal(ctx.config.MOLLIE_TOKEN, "access_uitDeApp1234567890");
    slaInstellingenOp(ctx, [{ sleutel: "MOLLIE_TOKEN", waarde: null }], "t");
    assert.equal(ctx.config.MOLLIE_TOKEN, "test_uitOmgeving123456");

    assert.throws(() => slaInstellingenOp(ctx, [{ sleutel: "ANTHROPIC_API_KEY", waarde: "geen-sleutel" }], "t"), /sk-ant-/);
    assert.throws(() => slaInstellingenOp(ctx, [{ sleutel: "BACKUP_UUR", waarde: 25 }], "t"));

    // age: publieke sleutel en wachtwoordzin sluiten elkaar uit
    slaInstellingenOp(ctx, [{ sleutel: "AGE_PASSPHRASE", waarde: "een lange wachtwoordzin" }], "t");
    assert.equal(ctx.config.AGE_PASSPHRASE, "een lange wachtwoordzin");
    slaInstellingenOp(ctx, [{ sleutel: "AGE_RECIPIENT", waarde: "age1gvv0thz5hkz9hr8z25wfqfsqks7t79s04vnaxt30nzrlr7hh9u4sgeqx0j" }], "t");
    assert.equal(ctx.config.AGE_PASSPHRASE, undefined);
    assert.ok(ctx.config.AGE_RECIPIENT?.startsWith("age1"));

    // Met een andere APP_SECRET (bv. herstel op nieuwe NAS) zijn geheimen niet leesbaar -> terugval, geen crash
    slaInstellingenOp(ctx, [{ sleutel: "MOLLIE_TOKEN", waarde: "access_uitDeApp1234567890" }], "t");
    ctx.config.APP_SECRET = "y".repeat(40);
    pasInstellingenToe(ctx);
    assert.equal(ctx.config.MOLLIE_TOKEN, "test_uitOmgeving123456");
  } finally {
    ctx.opruimen();
  }
});

test("Microsoft-ID's: geldige GUID wordt geaccepteerd, typfout (O i.p.v. 0) geweigerd", async () => {
  const ctx = await testCtx();
  try {
    slaInstellingenOp(ctx, [{ sleutel: "MS_CLIENT_ID", waarde: "6496e63c-96ca-4862-a664-0fd54b21e9fe" }, { sleutel: "MS_TENANT_ID", waarde: "74bb824f-1d13-4c03-a29d-f28ae1d7c42d" }], "t");
    assert.equal(ctx.config.MS_CLIENT_ID, "6496e63c-96ca-4862-a664-0fd54b21e9fe");
    assert.throws(() => slaInstellingenOp(ctx, [{ sleutel: "MS_CLIENT_ID", waarde: "6496e63c-96ca-4862-a664-Ofd54b21e9fe" }], "t"), /GUID/);
  } finally {
    ctx.opruimen();
  }
});

test("gedeelde mailbox: Graph-pad wisselt van /me naar /users/<mailbox>", async () => {
  const { mailbox } = await import("../src/integrations/outlook/index.ts");
  const ctx = await testCtx();
  try {
    assert.equal(mailbox(ctx), "/me");
    slaInstellingenOp(ctx, [{ sleutel: "MS_MAILBOX", waarde: "facturen@medialan.nl" }], "t");
    assert.equal(mailbox(ctx), "/users/facturen%40medialan.nl");
    assert.throws(() => slaInstellingenOp(ctx, [{ sleutel: "MS_MAILBOX", waarde: "geen-adres" }], "t"), /e-mailadres/);
    slaInstellingenOp(ctx, [{ sleutel: "MS_MAILBOX", waarde: null }], "t");
    assert.equal(mailbox(ctx), "/me");
  } finally {
    ctx.opruimen();
  }
});
