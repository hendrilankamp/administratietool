import fs from "node:fs";
import path from "node:path";

/** Gebruiker waaronder de app draait in de container (standaard 'node', 1000:1000). */
export const APP_UID = Number(process.env.PUID ?? 1000);
export const APP_GID = Number(process.env.PGID ?? 1000);

export const isRoot = () => typeof process.getuid === "function" && process.getuid() === 0;

/** Maakt `uid:gid` eigenaar van een map en alles daarin (alleen als de map zelf nog niet goed staat). */
export function maakEigenaar(dir: string, uid = APP_UID, gid = APP_GID): boolean {
  if (!fs.existsSync(dir)) return false;
  const st = fs.statSync(dir);
  if (st.uid === uid && st.gid === gid) return false;
  const loop = (p: string) => {
    fs.lchownSync(p, uid, gid);
    if (fs.lstatSync(p).isDirectory()) for (const f of fs.readdirSync(p)) loop(path.join(p, f));
  };
  loop(dir);
  return true;
}

/** Laat root-rechten los (onomkeerbaar). Doet niets als het proces al geen root is. */
export function verlaagRechten(uid = APP_UID, gid = APP_GID): void {
  if (!isRoot()) return;
  process.setgroups?.([gid]);
  process.setgid!(gid);
  process.setuid!(uid);
  if (process.getuid!() === 0) throw new Error("Kon root-rechten niet loslaten");
}
