import { Router } from "express";
import type { Ctx } from "../../lib/context.ts";
import { GebruikersFout } from "../../lib/context.ts";
import { leesBijlage } from "../../lib/bijlagen.ts";

export function bijlagenRouter(ctx: Ctx): Router {
  const r = Router();
  r.get("/:hash", (req, res) => {
    const hash = String(req.params.hash);
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new GebruikersFout("Ongeldige bijlage", 404);
    const b = leesBijlage(ctx, hash);
    if (!b) throw new GebruikersFout("Bijlage niet gevonden", 404);
    const download = req.query.download === "1";
    res.setHeader("Content-Type", b.mime);
    res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${b.bestandsnaam.replace(/[^\w.\- ()]/g, "_")}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600");
    // Eigen, strikte CSP voor het document zelf; ingesloten weergave alleen binnen deze app.
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'; frame-ancestors 'self'");
    res.send(b.data);
  });
  return r;
}
