import fs from "node:fs";
import type { Server } from "node:http";
import { laadConfig } from "./config.ts";
import { Db } from "./db/index.ts";
import { consoleLogger, type Ctx } from "./lib/context.ts";
import { Planner, taakStatus, voerTaakUit } from "./lib/taken.ts";
import { lijstBackups, maakBackup } from "./backup/maak.ts";
import { testHerstel, voerHerstelUitBijStart } from "./backup/herstel.ts";
import { verwerkAiWachtrij } from "./integrations/ai/extract.ts";
import { koppelStatus, outlookIngesteld, verwerkMailbox } from "./integrations/outlook/index.ts";
import { mollieIngesteld, syncMollie } from "./integrations/mollie/index.ts";
import { autoAfletteren } from "./modules/bank/service.ts";
import { maakApp } from "./web/app.ts";
import { initSetup } from "./web/auth.ts";
import { opruimenSessies } from "./web/sessie.ts";
import { pasInstellingenToe } from "./lib/instellingen.ts";
import type { Diensten } from "./web/diensten.ts";

async function start(): Promise<void> {
  const log = consoleLogger;
  const config = laadConfig();
  for (const d of [config.dataDir, config.bijlagenDir, config.backupDir]) fs.mkdirSync(d, { recursive: true, mode: 0o750 });

  // Een klaargezet herstel uitvoeren voordat de database wordt geopend
  const hersteld = voerHerstelUitBijStart(config, log);

  const db = new Db(config.dbPad);
  const ctx: Ctx = { config, db, log };
  const toegepast = await db.migreer(async () => {
    log.info("Databasemigratie nodig; eerst een backup maken");
    await maakBackup(ctx, "voor migratie");
  });
  if (toegepast.length) log.info(`Migraties toegepast: ${toegepast.join(", ")}`);
  if (hersteld) db.run("DELETE FROM sessies");
  // Koppelingen uit Instellingen (database) gaan vóór op omgevingsvariabelen
  pasInstellingenToe(ctx);
  if (config.appSecretAutomatisch) log.info(`Geheime sleutel: ${config.dataDir}/app-secret (automatisch aangemaakt; bewaar een kopie, zie Instellingen)`);
  initSetup(ctx);

  let server: Server | null = null;
  const planner = new Planner(ctx);

  const diensten: Diensten = {
    backupNu: (reden) =>
      voerTaakUit(ctx, "backup", async () => {
        const r = await maakBackup(ctx, reden);
        // Lokale backup is gelukt; een mislukte externe kopie moet wel zichtbaar falen
        if (r.externFout) throw new Error(`Lokale backup gemaakt, maar externe kopie mislukt: ${r.externFout}`);
        return r;
      }, (r) => (r.extern ? "met versleutelde externe kopie" : "alleen lokaal")),
    testHerstel: () => voerTaakUit(ctx, "testherstel", () => testHerstel(config), (m) => m),
    outlookOphalen: () =>
      voerTaakUit(
        ctx,
        "outlook",
        async () => {
          const r = await verwerkMailbox(ctx);
          if (r.facturen) void diensten.aiWachtrij();
          return `${r.berichten} bericht(en), ${r.facturen} factuur/facturen${r.zonderBijlage ? `, ${r.zonderBijlage} zonder bruikbare bijlage` : ""}`;
        },
        (m) => m,
      ),
    mollieSync: () =>
      voerTaakUit(
        ctx,
        "mollie",
        async () => {
          const m = await syncMollie(ctx);
          autoAfletteren(ctx);
          return m;
        },
        (m) => m,
      ),
    aiWachtrij: () => {
      void voerTaakUit(ctx, "ai", () => verwerkAiWachtrij(ctx), (n) => `${n} verwerkt`).catch(() => {});
    },
    herstart: () => {
      log.warn("Herstart aangevraagd (herstel). De container wordt door Docker opnieuw gestart.");
      planner.stop();
      server?.close(() => {
        db.close();
        process.exit(0);
      });
    },
  };

  // ---------- Planning ----------
  const MIN = 60_000;
  // Dagelijkse backup na BACKUP_UUR, of direct als de laatste ouder is dan 24 uur
  planner.elke(
    "backup-planner",
    10 * MIN,
    async () => {
      const laatste = lijstBackups(config.backupDir)[0];
      const leeftijd = laatste ? Date.now() - laatste.datum.getTime() : Infinity;
      const vandaagGedaan = laatste && laatste.datum.toDateString() === new Date().toDateString();
      if (leeftijd > 24 * 3600_000 || (!vandaagGedaan && new Date().getHours() >= config.BACKUP_UUR)) await diensten.backupNu("automatisch");
    },
    30_000,
  );
  // Wekelijks testherstel
  planner.elke("testherstel-planner", 60 * MIN, async () => {
    const s = taakStatus(ctx, "testherstel");
    const leeftijd = s?.laatst_gestart ? Date.now() - Date.parse(s.laatst_gestart) : Infinity;
    if (leeftijd > 7 * 24 * 3600_000 && lijstBackups(config.backupDir).length) await diensten.testHerstel();
  }, 5 * MIN);
  planner.elke("ai-planner", 2 * MIN, async () => diensten.aiWachtrij(), 20_000);
  // Outlook en Mollie: altijd ingepland; ze draaien zodra ze in Instellingen zijn gekoppeld (geen herstart nodig)
  const verstreken = (naam: string, minuten: number) => {
    const s = taakStatus(ctx, naam);
    return !s?.laatst_gestart || Date.now() - Date.parse(s.laatst_gestart) >= minuten * MIN - 30_000;
  };
  planner.elke("outlook-planner", 5 * MIN, async () => {
    if (!outlookIngesteld(ctx) || !verstreken("outlook", config.MS_POLL_MINUTEN)) return;
    if ((await koppelStatus(ctx)).status === "gekoppeld") await diensten.outlookOphalen();
  }, 60_000);
  planner.elke("mollie-planner", 5 * MIN, async () => {
    if (mollieIngesteld(ctx) && verstreken("mollie", 60)) await diensten.mollieSync();
  }, 90_000);
  planner.elke("opruimen", 60 * MIN, async () => opruimenSessies(ctx), 5_000);

  // ---------- Webserver ----------
  const app = maakApp(ctx, diensten);
  server = app.listen(config.PORT, config.HOST, () => {
    log.info(`Boekhouding Medialan draait op http://${config.HOST}:${config.PORT} (${config.NODE_ENV})`);
    if (!config.BACKUP_EXTERN_DIR) log.warn("BACKUP_EXTERN_DIR is niet ingesteld: er wordt geen (versleutelde) externe backupkopie gemaakt.");
  });

  const stop = (sig: string) => {
    log.info(`${sig} ontvangen, afsluiten...`);
    planner.stop();
    server?.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

start().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
