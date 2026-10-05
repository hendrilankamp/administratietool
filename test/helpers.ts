import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { laadConfig } from "../src/config.ts";
import { Db } from "../src/db/index.ts";
import { stilLogger, type Ctx } from "../src/lib/context.ts";

export async function testCtx(extraEnv: Record<string, string> = {}): Promise<Ctx & { opruimen: () => void; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boekhouding-test-"));
  const config = laadConfig({
    NODE_ENV: "test",
    DATA_DIR: path.join(dir, "data"),
    APP_SECRET: "test-geheim-dat-lang-genoeg-is-0123456789",
    ...extraEnv,
  });
  const db = new Db(config.dbPad);
  await db.migreer();
  const ctx = {
    config,
    db,
    log: stilLogger,
    dir,
    opruimen: () => {
      try {
        ctx.db.close();
      } catch {
        // al gesloten
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return ctx;
}

export const categorieId = (ctx: Ctx, naam: string): number =>
  ctx.db.get<{ id: number }>("SELECT id FROM categorieen WHERE naam = ?", [naam])!.id;
