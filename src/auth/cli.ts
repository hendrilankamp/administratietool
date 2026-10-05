/**
 * Noodhulp vanaf de commandoregel (Container Manager → container → Terminal: `node src/auth/cli.ts reset-2fa <gebruiker>`).
 *   reset-2fa <gebruiker>   – schakelt 2FA uit; bij de volgende login moet 2FA opnieuw worden ingesteld
 *   wachtwoord <gebruiker>  – stelt een nieuw wachtwoord in (wordt gevraagd)
 */
import readline from "node:readline/promises";
import { laadConfig } from "../config.ts";
import { verlaagRechten } from "../lib/rechten.ts";
import { Db } from "../db/index.ts";
import { audit } from "../lib/context.ts";
import { hashWachtwoord } from "../lib/crypto.ts";

async function main() {
  const [cmd, gebruiker] = process.argv.slice(2);
  if (!cmd || !gebruiker) {
    console.log("Gebruik: cli.ts reset-2fa <gebruiker> | wachtwoord <gebruiker>");
    process.exit(1);
  }
  // In de container (Terminal in Container Manager draait als root): als app-gebruiker werken,
  // zodat de database niet van root wordt.
  verlaagRechten();
  const config = laadConfig();
  const db = new Db(config.dbPad);
  try {
    const g = db.get<{ id: number }>("SELECT id FROM gebruikers WHERE gebruikersnaam = ?", [gebruiker]);
    if (!g) throw new Error(`Gebruiker ${gebruiker} niet gevonden`);
    if (cmd === "reset-2fa") {
      db.run("UPDATE gebruikers SET totp_geheim = NULL, totp_actief = 0 WHERE id = ?", [g.id]);
      db.run("DELETE FROM sessies WHERE gebruiker_id = ?", [g.id]);
      audit(db, "cli", "2fa_gereset", "gebruikers", g.id);
      console.log("2FA is uitgeschakeld. Log in en stel 2FA opnieuw in.");
    } else if (cmd === "wachtwoord") {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const w = (await rl.question("Nieuw wachtwoord (min. 12 tekens): ")).trim();
      rl.close();
      if (w.length < 12) throw new Error("Wachtwoord te kort");
      db.run("UPDATE gebruikers SET wachtwoord_hash = ? WHERE id = ?", [hashWachtwoord(w), g.id]);
      db.run("DELETE FROM sessies WHERE gebruiker_id = ?", [g.id]);
      audit(db, "cli", "wachtwoord_gereset", "gebruikers", g.id);
      console.log("Wachtwoord ingesteld.");
    } else throw new Error(`Onbekend commando ${cmd}`);
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
