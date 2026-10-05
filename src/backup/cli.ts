/**
 * Backup-hulpmiddel voor de commandoregel.
 * In de container (Container Manager → container → Terminal):
 *   node src/backup/cli.ts backup                    – maak nu een backup
 *   node src/backup/cli.ts verify <bestand.zip>      – controleer checksums
 *   node src/backup/cli.ts restore <bestand> [--json] [--identity <keyfile>]
 *       Zet een herstel klaar; dit wordt uitgevoerd bij de volgende start van de app (herstart de container).
 *   node src/backup/cli.ts test                      – testherstel van de nieuwste backup
 */
import fs from "node:fs";
import readline from "node:readline/promises";
import { laadConfig } from "../config.ts";
import { verlaagRechten } from "../lib/rechten.ts";
import { Db } from "../db/index.ts";
import { consoleLogger } from "../lib/context.ts";
import { pasInstellingenToe } from "../lib/instellingen.ts";
import { maakBackup, verifieerZip } from "./maak.ts";
import { bereidHerstelVoor, testHerstel } from "./herstel.ts";

async function vraag(tekst: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(tekst)).trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  // In de container (Terminal in Container Manager draait als root): als app-gebruiker werken,
  // zodat de database niet van root wordt.
  verlaagRechten();
  const config = laadConfig();
  // Instellingen uit de webinterface (bv. de age-wachtwoordzin) ook hier gebruiken
  if (fs.existsSync(config.dbPad)) {
    const db = new Db(config.dbPad);
    try {
      pasInstellingenToe({ config, db, log: consoleLogger });
    } finally {
      db.close();
    }
  }
  switch (cmd) {
    case "backup": {
      const db = new Db(config.dbPad);
      try {
        const r = await maakBackup({ config, db, log: consoleLogger }, "handmatig (cli)");
        console.log(`Backup: ${r.bestand}${r.extern ? `\nExtern: ${r.extern}` : ""}`);
      } finally {
        db.close();
      }
      break;
    }
    case "verify": {
      if (!args[0]) throw new Error("Geef het pad naar een .zip-backup op");
      const m = await verifieerZip(args[0]);
      console.log(`OK – ${Object.keys(m.bestanden).length} bestanden, gemaakt op ${m.aangemaaktOp}, schemaversie ${m.schemaVersie}`);
      break;
    }
    case "restore": {
      const bestand = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--identity");
      if (!bestand || !fs.existsSync(bestand)) throw new Error("Geef het pad naar een bestaande backup (.zip of .zip.age) op");
      const idIndex = args.indexOf("--identity");
      const identity = idIndex >= 0 ? fs.readFileSync(args[idIndex + 1], "utf8").split("\n").find((l) => l.startsWith("AGE-SECRET-KEY-")) : undefined;
      let passphrase: string | undefined;
      if (bestand.endsWith(".age") && !identity && !config.AGE_PASSPHRASE) passphrase = await vraag("age-wachtwoordzin: ");
      const ok = await vraag(`Herstel klaarzetten vanuit ${bestand}? De huidige database wordt bij de volgende start vervangen (en bewaard in data/vorige-databases). Typ HERSTEL om door te gaan: `);
      if (ok !== "HERSTEL") {
        console.log("Afgebroken.");
        return;
      }
      // Eerst een backup van de huidige toestand
      if (fs.existsSync(config.dbPad)) {
        const db = new Db(config.dbPad);
        try {
          await maakBackup({ config, db, log: consoleLogger }, "voor herstel");
        } finally {
          db.close();
        }
      }
      const r = await bereidHerstelVoor(config, bestand, { passphrase, identity, forceerJson: args.includes("--json") });
      console.log(`Herstel klaargezet (${r.modus}, backup van ${r.manifest.aangemaaktOp}). Herstart nu de app/container om het uit te voeren.`);
      break;
    }
    case "test": {
      console.log(await testHerstel(config));
      break;
    }
    default:
      console.log("Gebruik: cli.ts backup | verify <zip> | restore <bestand> [--json] [--identity <keyfile>] | test");
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
