import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import multer from "multer";
import { z } from "zod";
import type { Ctx } from "../lib/context.ts";
import { GebruikersFout } from "../lib/context.ts";
import { authRouter } from "./auth.ts";
import { csrfMiddleware, sessieMiddleware, vereisLogin, zetFlash } from "./sessie.ts";
import { render } from "./render.ts";
import type { Diensten } from "./diensten.ts";
import { inkoopRouter } from "./routes/inkoop.ts";
import { verkoopRouter } from "./routes/verkoop.ts";
import { relatiesRouter } from "./routes/relaties.ts";
import { bijlagenRouter } from "./routes/bijlagen.ts";
import { bankRouter } from "./routes/bank.ts";
import { importRouter } from "./routes/import.ts";
import { btwRouter, dashboardRouter, instellingenRouter, rapportagesRouter } from "./routes/overig.ts";

const hier = path.dirname(fileURLToPath(import.meta.url));

export function maakApp(ctx: Ctx, diensten: Diensten): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", path.join(hier, "..", "views"));
  if (ctx.config.TRUST_PROXY) app.set("trust proxy", ctx.config.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
        },
      },
      frameguard: { action: "sameorigin" },
      // Geen HSTS: de app moet ook via http://nas-ip:3000 op het LAN bereikbaar blijven
      strictTransportSecurity: false,
      referrerPolicy: { policy: "same-origin" },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });

  app.get("/health", (_req, res) => {
    ctx.db.get("SELECT 1");
    res.json({ ok: true });
  });
  app.use("/static", express.static(path.join(hier, "..", "public"), { maxAge: "1h", index: false }));
  app.use(express.urlencoded({ extended: true, limit: "2mb", parameterLimit: 5000 }));
  app.use(sessieMiddleware(ctx));
  app.use(csrfMiddleware);

  app.use(authRouter(ctx));
  app.use(vereisLogin);
  app.use("/", dashboardRouter(ctx));
  app.use("/inkoop", inkoopRouter(ctx, diensten));
  app.use("/verkoop", verkoopRouter(ctx, diensten));
  app.use("/relaties", relatiesRouter(ctx));
  app.use("/bijlagen", bijlagenRouter(ctx));
  app.use("/bank", bankRouter(ctx));
  app.use("/import", importRouter(ctx));
  app.use("/btw", btwRouter(ctx));
  app.use("/rapportages", rapportagesRouter(ctx));
  app.use("/instellingen", instellingenRouter(ctx, diensten));

  app.use((req, res) => {
    res.status(404);
    render(ctx, req, res, "fout", { titel: "Niet gevonden", melding: "Deze pagina bestaat niet." });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let status = 500;
    let melding = "Er ging iets mis. De fout is gelogd.";
    if (err instanceof GebruikersFout) {
      status = err.status;
      melding = err.message;
    } else if (err instanceof z.ZodError) {
      status = 400;
      melding = err.issues.map((i) => `${i.path.join(".") || "invoer"}: ${i.message}`).join("; ");
    } else if (err instanceof multer.MulterError) {
      status = 400;
      melding = err.code === "LIMIT_FILE_SIZE" ? "Bestand is te groot" : `Upload mislukt: ${err.message}`;
    } else {
      ctx.log.error(`${req.method} ${req.originalUrl}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
    if (res.headersSent) return;
    // Bij een formulierfout: melding tonen op de vorige pagina (Post/Redirect/Get)
    const terug = req.get("referer");
    if (req.method === "POST" && status < 500 && req.sessie && terug) {
      try {
        const u = new URL(terug);
        if (u.host === req.get("host")) {
          zetFlash(ctx, req, { type: "fout", tekst: melding });
          return res.redirect(303, u.pathname + u.search + u.hash);
        }
      } catch {
        // val terug op foutpagina
      }
    }
    res.status(status);
    render(ctx, req, res, "fout", { titel: status === 500 ? "Fout" : "Let op", melding });
  });

  return app;
}
