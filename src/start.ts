/**
 * Startpunt in de container. Draait kort als root om de gekoppelde mappen (data en backup) van de
 * app-gebruiker te maken, laat daarna alle root-rechten los en start de server.
 * Zo hoef je op de Synology geen gebruikers-ID's op te zoeken of rechten in te stellen.
 */
import { APP_GID, APP_UID, isRoot, maakEigenaar, verlaagRechten } from "./lib/rechten.ts";

if (isRoot()) {
  for (const dir of [process.env.DATA_DIR, process.env.BACKUP_EXTERN_DIR]) {
    if (!dir) continue;
    try {
      if (maakEigenaar(dir)) console.log(`Rechten van ${dir} ingesteld op ${APP_UID}:${APP_GID}`);
    } catch (e) {
      console.error(`Kon rechten van ${dir} niet instellen: ${(e as Error).message}`);
    }
  }
  verlaagRechten();
}

await import("./server.ts");
