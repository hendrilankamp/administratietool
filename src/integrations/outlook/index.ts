import fs from "node:fs";
import path from "node:path";
import { PublicClientApplication, type ICachePlugin, type TokenCacheContext } from "@azure/msal-node";
import type { Ctx } from "../../lib/context.ts";
import { audit, GebruikersFout } from "../../lib/context.ts";
import { ontsleutel, versleutel } from "../../lib/crypto.ts";
import { bewaarBijlage, detecteerType, MAX_BIJLAGE } from "../../lib/bijlagen.ts";
import { nieuweInkoopfactuur } from "../../modules/facturen/service.ts";
import { isEigenOnderwerp } from "../../modules/facturen/eigen.ts";
import { mollieIngesteld } from "../mollie/index.ts";

// Mail.ReadWrite.Shared: nodig om een gedeelde mailbox te lezen waar de ingelogde gebruiker toegang toe heeft
const SCOPES = ["Mail.ReadWrite", "Mail.ReadWrite.Shared", "offline_access"];
const GRAPH = "https://graph.microsoft.com/v1.0";

export interface KoppelStatus {
  status: "niet_ingesteld" | "niet_gekoppeld" | "wachten_op_login" | "gekoppeld" | "fout";
  account?: string;
  gebruikerscode?: string;
  verificatieUrl?: string;
  verlooptOp?: string;
  melding?: string;
}

let lopendeLogin: KoppelStatus | null = null;
let pcaCache: { sleutel: string; pca: PublicClientApplication } | null = null;

function cachePad(ctx: Ctx) {
  return path.join(ctx.config.dataDir, "msal-cache.enc");
}

function cachePlugin(ctx: Ctx): ICachePlugin {
  return {
    async beforeCacheAccess(c: TokenCacheContext) {
      const p = cachePad(ctx);
      if (fs.existsSync(p)) {
        try {
          c.tokenCache.deserialize(ontsleutel(fs.readFileSync(p, "utf8"), ctx.config.APP_SECRET, "msal-cache"));
        } catch {
          ctx.log.error("Microsoft token-cache kon niet worden ontsleuteld (APP_SECRET gewijzigd?). Koppel Outlook opnieuw.");
        }
      }
    },
    async afterCacheAccess(c: TokenCacheContext) {
      if (!c.cacheHasChanged) return;
      const p = cachePad(ctx);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(`${p}.tmp`, versleutel(c.tokenCache.serialize(), ctx.config.APP_SECRET, "msal-cache"), { mode: 0o600 });
      fs.renameSync(`${p}.tmp`, p);
    },
  };
}

export function outlookIngesteld(ctx: Ctx): boolean {
  return !!(ctx.config.MS_CLIENT_ID && ctx.config.MS_TENANT_ID);
}

function pca(ctx: Ctx): PublicClientApplication {
  if (!outlookIngesteld(ctx)) throw new GebruikersFout("Outlook is nog niet ingesteld (Instellingen → Outlook)");
  const sleutel = `${ctx.config.MS_CLIENT_ID}|${ctx.config.MS_TENANT_ID}|${ctx.config.dataDir}`;
  if (pcaCache?.sleutel !== sleutel) {
    pcaCache = {
      sleutel,
      pca: new PublicClientApplication({
        auth: { clientId: ctx.config.MS_CLIENT_ID!, authority: `https://login.microsoftonline.com/${ctx.config.MS_TENANT_ID}` },
        cache: { cachePlugin: cachePlugin(ctx) },
      }),
    };
  }
  return pcaCache.pca;
}

export async function koppelStatus(ctx: Ctx): Promise<KoppelStatus> {
  if (!outlookIngesteld(ctx)) return { status: "niet_ingesteld" };
  if (lopendeLogin) return lopendeLogin;
  const accounts = await pca(ctx).getTokenCache().getAllAccounts();
  if (accounts.length === 0) return { status: "niet_gekoppeld" };
  return { status: "gekoppeld", account: accounts[0].username };
}

/** Start de device-code login. De gebruiker gaat naar de getoonde URL en voert de code in. */
export async function startKoppelen(ctx: Ctx, gebruiker: string): Promise<KoppelStatus> {
  if (lopendeLogin?.status === "wachten_op_login") return lopendeLogin;
  const app = pca(ctx);
  return new Promise<KoppelStatus>((resolve) => {
    let opgelost = false;
    app
      .acquireTokenByDeviceCode({
        scopes: SCOPES,
        deviceCodeCallback: (r) => {
          lopendeLogin = {
            status: "wachten_op_login",
            gebruikerscode: r.userCode,
            verificatieUrl: r.verificationUri,
            verlooptOp: new Date(Date.now() + r.expiresIn * 1000).toISOString(),
            melding: r.message,
          };
          opgelost = true;
          resolve(lopendeLogin);
        },
      })
      .then((res) => {
        lopendeLogin = null;
        audit(ctx.db, gebruiker, "outlook_gekoppeld", "outlook", undefined, { account: res?.account?.username });
        ctx.log.info(`Outlook gekoppeld: ${res?.account?.username}`);
      })
      .catch((e: Error) => {
        const melding = microsoftFout(e);
        ctx.log.error(`Outlook koppelen mislukt: ${melding}`);
        lopendeLogin = { status: "fout", melding };
        setTimeout(() => (lopendeLogin = null), 60_000);
        if (!opgelost) resolve(lopendeLogin);
      });
  });
}

/** Maakt een MSAL-fout leesbaar, inclusief AADSTS-code en een Nederlandse uitleg voor bekende gevallen. */
export function microsoftFout(e: unknown): string {
  const f = e as { message?: string; errorCode?: string; errorMessage?: string; subError?: string };
  const tekst = [f.message, f.errorMessage, f.subError].filter(Boolean).join(" | ");
  const code = /AADSTS\d+/.exec(tekst)?.[0];
  const uitleg: Record<string, string> = {
    AADSTS7000218: "Zet in Entra bij de app → Authentication → 'Allow public client flows' op Yes en sla op.",
    AADSTS700016: "De Toepassings-ID bestaat niet in deze tenant: controleer Toepassings-ID en Map-ID.",
    AADSTS90002: "De Map-ID (tenant) bestaat niet: controleer de Map-ID.",
    AADSTS65001: "Toestemming ontbreekt: geef in Entra → API permissions 'Grant admin consent'.",
    AADSTS50020: "Dit account hoort niet bij deze organisatie: log in met een account van je eigen Microsoft 365.",
  };
  const hint = code ? uitleg[code] : /invalid_client/.test(tekst) ? uitleg.AADSTS7000218 : undefined;
  return `${tekst.slice(0, 600)}${hint ? ` → ${hint}` : ""}`;
}

export async function ontkoppel(ctx: Ctx, gebruiker: string): Promise<void> {
  const app = pca(ctx);
  for (const a of await app.getTokenCache().getAllAccounts()) await app.getTokenCache().removeAccount(a);
  fs.rmSync(cachePad(ctx), { force: true });
  lopendeLogin = null;
  audit(ctx.db, gebruiker, "outlook_ontkoppeld", "outlook");
}

async function token(ctx: Ctx): Promise<string> {
  const app = pca(ctx);
  const [account] = await app.getTokenCache().getAllAccounts();
  if (!account) throw new GebruikersFout("Outlook is niet gekoppeld");
  const r = await app.acquireTokenSilent({ account, scopes: SCOPES });
  return r.accessToken;
}

async function graph<T>(ctx: Ctx, pad: string, init: RequestInit = {}, poging = 0): Promise<T> {
  const res = await fetch(pad.startsWith("http") ? pad : `${GRAPH}${pad}`, {
    ...init,
    headers: { Authorization: `Bearer ${await token(ctx)}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  });
  if ((res.status === 429 || res.status >= 500) && poging < 4) {
    const wacht = Number(res.headers.get("retry-after") ?? 2 ** poging) * 1000;
    await new Promise((r) => setTimeout(r, Math.min(wacht, 60_000)));
    return graph<T>(ctx, pad, init, poging + 1);
  }
  if (!res.ok) {
    const tekst = (await res.text()).slice(0, 300);
    if ((res.status === 403 || res.status === 404) && ctx.config.MS_MAILBOX) {
      throw new GebruikersFout(`Geen toegang tot de gedeelde mailbox ${ctx.config.MS_MAILBOX} (${res.status}). Geef je account "Volledige toegang" op die mailbox in het Exchange-beheercentrum en koppel Outlook opnieuw.`, 502);
    }
    throw new Error(`Microsoft Graph ${res.status}: ${tekst}`);
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("application/json") ? await res.json() : Buffer.from(await res.arrayBuffer())) as T;
}

interface Map_ {
  id: string;
  displayName: string;
}

/** Graph-pad van de mailbox: een gedeelde mailbox (MS_MAILBOX) of de eigen mailbox van de ingelogde gebruiker. */
export function mailbox(ctx: Ctx): string {
  return ctx.config.MS_MAILBOX ? `/users/${encodeURIComponent(ctx.config.MS_MAILBOX)}` : "/me";
}

const odataString = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function zoekMap(ctx: Ctx, naam: string, ouderId?: string): Promise<Map_ | undefined> {
  const filter = `?$filter=displayName eq ${encodeURIComponent(odataString(naam))}`;
  const pad = ouderId ? `${mailbox(ctx)}/mailFolders/${ouderId}/childFolders${filter}` : `${mailbox(ctx)}/mailFolders${filter}`;
  const r = await graph<{ value: Map_[] }>(ctx, pad);
  return r.value[0];
}

async function bronMap(ctx: Ctx): Promise<Map_> {
  const naam = ctx.config.MS_MAP;
  const m = (await zoekMap(ctx, naam)) ?? (await zoekMap(ctx, naam, "inbox"));
  if (!m) throw new GebruikersFout(`Map "${naam}" niet gevonden in ${ctx.config.MS_MAILBOX ?? "je mailbox"}. Maak deze map aan (bovenaan of onder Postvak IN).`);
  return m;
}

async function verwerktMap(ctx: Ctx, ouder: Map_): Promise<Map_> {
  const naam = ctx.config.MS_MAP_VERWERKT;
  const m = await zoekMap(ctx, naam, ouder.id);
  if (m) return m;
  return graph<Map_>(ctx, `${mailbox(ctx)}/mailFolders/${ouder.id}/childFolders`, { method: "POST", body: JSON.stringify({ displayName: naam }) });
}

interface Bericht {
  id: string;
  subject: string | null;
  internetMessageId: string;
  receivedDateTime: string;
  hasAttachments: boolean;
  from?: { emailAddress?: { address?: string; name?: string } };
}

interface Bijlage {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  "@odata.type": string;
}

/** Minimale grootte voor afbeeldingen: kleinere plaatjes zijn meestal logo's in een handtekening. */
const MIN_AFBEELDING = 30 * 1024;

export interface MailResultaat {
  berichten: number;
  facturen: number;
  zonderBijlage: number;
}

/**
 * Leest nieuwe berichten in de map "Facturen", maakt per bruikbare bijlage een inkoopfactuur "te beoordelen"
 * en verplaatst het bericht naar "Facturen/Verwerkt".
 */
export async function verwerkMailbox(ctx: Ctx): Promise<MailResultaat> {
  const bron = await bronMap(ctx);
  const doel = await verwerktMap(ctx, bron);
  const res: MailResultaat = { berichten: 0, facturen: 0, zonderBijlage: 0 };
  let volgende: string | undefined =
    `${mailbox(ctx)}/mailFolders/${bron.id}/messages?$select=id,subject,from,receivedDateTime,internetMessageId,hasAttachments&$orderby=receivedDateTime asc&$top=25`;
  let rondes = 0;
  while (volgende && rondes++ < 20) {
    const pagina: { value: Bericht[]; "@odata.nextLink"?: string } = await graph(ctx, volgende);
    for (const b of pagina.value) {
      await verwerkBericht(ctx, b, res);
      await graph(ctx, `${mailbox(ctx)}/messages/${b.id}/move`, { method: "POST", body: JSON.stringify({ destinationId: doel.id }) });
    }
    // Na het verplaatsen schuift de lijst op; begin opnieuw zolang er berichten waren.
    volgende = pagina.value.length > 0 ? `${mailbox(ctx)}/mailFolders/${bron.id}/messages?$select=id,subject,from,receivedDateTime,internetMessageId,hasAttachments&$orderby=receivedDateTime asc&$top=25` : undefined;
  }
  return res;
}

async function verwerkBericht(ctx: Ctx, b: Bericht, res: MailResultaat): Promise<void> {
  const bekend = ctx.db.get("SELECT id FROM email_berichten WHERE internet_message_id = ?", [b.internetMessageId]);
  if (bekend) return; // al eerder verwerkt (bv. verplaatsen mislukte vorige keer)
  res.berichten++;
  const afzender = b.from?.emailAddress?.address ?? null;
  const berichtId = ctx.db.run(
    "INSERT INTO email_berichten (graph_id, internet_message_id, onderwerp, afzender, ontvangen_op, verwerkt_op) VALUES (?, ?, ?, ?, ?, ?)",
    [b.id, b.internetMessageId, b.subject, afzender, b.receivedDateTime, new Date().toISOString()],
  ).id;

  let aantal = 0;
  const fouten: string[] = [];
  if (isEigenOnderwerp(ctx, b.subject) && mollieIngesteld(ctx)) {
    // Kopie van een Mollie-factuur: komt al via de Mollie-koppeling binnen
    ctx.db.run("UPDATE email_berichten SET fout = ? WHERE id = ?", ["Eigen factuur (Mollie); niet als inkoop verwerkt", berichtId]);
    return;
  }
  if (b.hasAttachments) {
    const lijst = await graph<{ value: Bijlage[] }>(ctx, `${mailbox(ctx)}/messages/${b.id}/attachments?$select=id,name,contentType,size,isInline`);
    for (const a of lijst.value) {
      if (a["@odata.type"] !== "#microsoft.graph.fileAttachment" || a.isInline) continue;
      if (a.size > MAX_BIJLAGE + 64 * 1024) {
        fouten.push(`${a.name}: te groot`);
        continue;
      }
      const isPdf = /pdf/i.test(a.contentType) || /\.pdf$/i.test(a.name);
      const isAfb = /image\/(png|jpe?g)/i.test(a.contentType);
      if (!isPdf && !(isAfb && a.size >= MIN_AFBEELDING)) continue;
      const data = await graph<Buffer>(ctx, `${mailbox(ctx)}/messages/${b.id}/attachments/${a.id}/$value`);
      if (!detecteerType(data)) {
        fouten.push(`${a.name}: geen geldige PDF/afbeelding`);
        continue;
      }
      const opgeslagen = bewaarBijlage(ctx, data, a.name);
      const alGekoppeld = ctx.db.get("SELECT id FROM inkoopfacturen WHERE bijlage_sha256 = ?", [opgeslagen.sha256]);
      if (alGekoppeld) continue; // zelfde PDF al eerder ontvangen
      nieuweInkoopfactuur(ctx, "email", {
        bijlage: opgeslagen.sha256,
        emailBerichtId: berichtId,
        aiStatus: ctx.config.ANTHROPIC_API_KEY ? "wachtrij" : "overgeslagen",
        gebruiker: "outlook",
        omschrijving: b.subject?.slice(0, 200) ?? undefined,
      });
      aantal++;
    }
  }
  if (aantal === 0) res.zonderBijlage++;
  res.facturen += aantal;
  ctx.db.run("UPDATE email_berichten SET aantal_bijlagen = ?, fout = ? WHERE id = ?", [
    aantal,
    fouten.length ? fouten.join("; ") : aantal === 0 ? "Geen bruikbare PDF-bijlage gevonden" : null,
    berichtId,
  ]);
}
