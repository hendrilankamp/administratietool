# Boekhouding Medialan

Eenvoudig, veilig boekhoudprogramma voor een BTW-plichtige eenmanszaak/VOF. Draait als container op een Synology NAS (of lokaal) en is alleen bereikbaar binnen het eigen netwerk.

**Wat het doet**

| Onderdeel | Hoe |
|---|---|
| Inkoopfacturen | Automatisch uit de Outlook-map *Facturen* (Microsoft 365) of door PDF's te slepen. Claude leest leverancier, bedragen en BTW uit; jij controleert en keurt goed. |
| Verkoopfacturen | Automatische import uit Mollie Facturatie (incl. PDF en betaalstatus) en handmatig vastleggen. |
| Bank (N26) | CSV-import (N26, ING, Rabobank of eigen profiel), automatische ontdubbeling, afletteren van transacties tegen facturen, Mollie-uitbetalingen (meerdere facturen + ingehouden kosten), boeken zonder factuur, saldocontrole. |
| BTW | Kwartaaloverzicht per aangifterubriek (1a t/m 5c, incl. verlegd/EU), afronding zoals de aangifte, periode afsluiten. |
| Rapportages | Winst & verlies, openstaande debiteuren/crediteuren, export voor de accountant (CSV + PDF's). |
| Backups | Dagelijks, machineleesbaar (JSON + CSV + PDF + SQLite), met checksums, `age`-versleutelde externe kopie, rotatie (≥ 7 jaar) en wekelijks automatisch testherstel. |
| Beveiliging | Wachtwoord + verplichte 2FA, CSRF-bescherming, strikte CSP, audit-log, read-only container die niet als root draait, API-sleutels versleuteld opgeslagen. |

---

## 1. Installatie op de Synology (± 15 minuten)

Vereist: DSM 7.2 of nieuwer met **Container Manager** (Pakketcentrum). Geen SSH, geen `.env`-bestand en geen gebruikers-ID's nodig.

### Eenmalig: het image laten bouwen door GitHub

GitHub bouwt bij elke wijziging automatisch een kant-en-klaar image voor zowel Intel- als ARM-Synology's.

De code staat in [github.com/hendrilankamp/administratietool](https://github.com/hendrilankamp/administratietool). Bij elke push naar `main` test GitHub de code en bouwt het image **`ghcr.io/hendrilankamp/administratietool`** (tabblad **Actions**; duurt ± 5 minuten).
Geef de Synology eenmalig leestoegang tot het (privé) image:
   - GitHub → Settings → Developer settings → **Personal access tokens (classic)** → nieuw token met alleen `read:packages`.
   - Container Manager → **Register** → Instellingen → **Toevoegen**: naam `GitHub`, URL `https://ghcr.io`, je GitHub-naam, en het token als wachtwoord.

   (Alternatief: zet het package op github.com → je profiel → Packages → administratietool → Package settings op *Public*. Het image bevat alleen programmacode, geen gegevens of sleutels. Dan is deze stap niet nodig.)

### Op de Synology

1. **File Station**: maak twee mappen:
   - `docker/boekhouding` (database, facturen en lokale backups)
   - een gedeelde map `backup` met daarin `boekhouding` (versleutelde backups)
2. **Container Manager → Project → Maken**
   - Projectnaam: `boekhouding`
   - Pad: `/volume1/docker/boekhouding`
   - Bron: **docker-compose.yml maken** en plak de inhoud van [`docker-compose.yml`](docker-compose.yml).
   - Volgende → Klaar. Het image wordt opgehaald en de container gestart.
3. **Container Manager → Container → boekhouding → Log**: kopieer het **setup-token**.
4. Open **`http://<ip-van-je-nas>:3000`**, maak je gebruiker aan met het token en stel 2FA in met een authenticator-app.
5. Ga in de app naar **Instellingen** en vul de koppelingen in. Elk onderdeel heeft een testknop:
   - **Backupbeveiliging**: klik *Sleutelpaar maken* en bewaar de getoonde geheime sleutel in je wachtwoordmanager. Klik ook *Herstelsleutel tonen* en bewaar die.
   - **Mollie**: Organization access token met `sales-invoices.read` en `settlements.read`.
   - **AI-uitlezen**: Anthropic API-sleutel.
   - **Outlook**: volg de stappen op de pagina (app-registratie in Microsoft Entra), en klik daarna *Outlook koppelen*.
6. **Hyper Backup**: maak een taak voor de map `backup/boekhouding` naar Synology C2, een USB-schijf of een tweede NAS (of gebruik **Cloud Sync** naar OneDrive). De bestanden daarin zijn al versleuteld.

De container zet bij het opstarten zelf de rechten van beide mappen goed en draait daarna als gewone gebruiker (niet als root).

### Beveiligingsadvies voor toegang via `http://nas-ip:3000`

- Het verkeer binnen je netwerk is onversleuteld. Gebruik de app alleen op je eigen (bekabelde of goed beveiligde wifi-)netwerk.
- **Zet geen poort open op de router.** Van buiten kantoor alleen via Synology **VPN Server** of **Tailscale**.
- **DSM-firewall** (Configuratiescherm → Beveiliging → Firewall): sta poort 3000 alleen toe vanaf je LAN-/VPN-subnet.
- Wil je later toch HTTPS? Maak in DSM een reverse proxy (Configuratiescherm → Aanmeldingsportaal → Geavanceerd → Reverse proxy: HTTPS 443 → http://localhost:3000) en zet in `docker-compose.yml` bij `environment:` de regel `TRUST_PROXY: uniquelocal`. Cookies worden dan automatisch alleen via HTTPS verstuurd.

---

## 2. Lokaal uitproberen (Mac)

Vereist: Node.js 24.

```bash
npm install
npm start            # draait op http://127.0.0.1:3000 met data in ./data
```

In de terminal staat het eenmalige setup-token. Een `.env` is niet nodig (zie `.env.example` voor optionele instellingen).

Tests: `npm test` · typecontrole: `npm run typecheck`.

Zonder GitHub op de NAS bouwen kan ook met [`deploy/docker-compose.lokaal-bouwen.yml`](deploy/docker-compose.lokaal-bouwen.yml).

---

## 3. Dagelijks gebruik

1. **Inkoop → Te beoordelen**: facturen uit Outlook of geüpload staan klaar met een AI-voorstel en de PDF ernaast. Controleer de gele meldingen, kies zo nodig de leverancier (of maak hem aan vanuit het voorstel) en klik **Goedkeuren & boeken**. Je gaat dan automatisch door naar de volgende.
2. **Verkoop**: Mollie synchroniseert elk uur (of klik *Nu synchroniseren*). Facturen buiten Mollie leg je handmatig vast.
3. **Bank** (bv. maandelijks): exporteer in de N26-app een CSV en importeer die via **CSV importeren**. Overlappende periodes zijn geen probleem. Daarna **Afletteren**:
   - Eenduidige matches (factuurnummer + bedrag, of een sluitende Mollie-uitbetaling) worden automatisch gekoppeld.
   - Klik op een voorstel om te koppelen, of boek zonder factuur (bankkosten, privé, belastingen). Vink *Onthoud als bankregel* aan voor terugkerende posten.
   - **Factuur ontbreekt** toont afschrijvingen zonder factuur.
   - Vul af en toe het saldo uit de N26-app in bij **Rekeningen** om te controleren of de import compleet is.
4. **BTW** (per kwartaal): open het kwartaal, los de waarschuwingen op, neem de bedragen over in de aangifte bij de Belastingdienst en klik daarna **Kwartaal afsluiten**.
5. **Jaarafsluiting**: Rapportages → *Export voor accountant*.

---

## 4. Backups en herstel

**Wanneer:** dagelijks na `BACKUP_UUR`, bij opstarten als de laatste ouder is dan 24 uur, vóór elke databasemigratie, vóór een herstel en via *Instellingen → Backup nu*.

**Bewaartermijn:** 7 dagelijkse, 4 wekelijkse, 12 maandelijkse en 10 jaarlijkse backups (fiscale bewaarplicht: 7 jaar).

**Formaat** (`medialan-backup-JJJJ-MM-DDTUUMMSS.zip`):

```
manifest.json              formaat/schemaversie, tijdstip, aantallen per tabel, controletotalen, sha256 per bestand
data/<tabel>.json          alle rijen per tabel (bedragen in hele centen, datums JJJJ-MM-DD)
csv/<tabel>.csv            dezelfde data als CSV (UTF-8, ';') voor Excel/accountant
schema/<tabel>.schema.json JSON Schema per tabel
attachments/<sha256>.pdf   originele facturen (naam = sha256 van de inhoud)
database.sqlite            consistente SQLite-snapshot
LEESMIJ.txt                uitleg
```

Wachtwoord-hashes en 2FA-geheimen staan niet in de JSON/CSV-bestanden.

**Controle:** na elke backup worden alle checksums gecontroleerd. Elke week wordt de nieuwste backup automatisch op twee manieren in een tijdelijke map hersteld (via SQLite én via alleen de JSON) en vergeleken met het manifest. De uitkomst staat op het dashboard.

**Herstellen in de app:** Instellingen → Backups → *Herstellen…* → typ `HERSTEL`. De app maakt eerst een backup van de huidige toestand, zet het herstel klaar en herstart. De vorige database wordt bewaard in `data/vorige-databases/`.

**Herstellen vanaf een externe (versleutelde) kopie**, bv. op een nieuwe NAS:

1. Installeer zoals in hoofdstuk 1, maar zet vóór de eerste start je **herstelsleutel** als bestand `app-secret` in `docker/boekhouding` (dan blijven API-sleutels, Outlook-koppeling en 2FA geldig).
2. Zet je geheime backupsleutel als bestand `medialan.key` in `backup/boekhouding`.
3. Container Manager → Container → boekhouding → **Terminal** → Maken → `sh`, en voer uit:
   ```sh
   node src/backup/cli.ts restore /backup-extern/medialan-backup-....zip.age --identity /backup-extern/medialan.key
   ```
   (bij een wachtwoordzin laat je `--identity` weg; de app vraagt erom). Herstart daarna de container en verwijder `medialan.key` weer.

Na een herstel uit alleen JSON (`--json`) moet je de gebruiker opnieuw aanmaken (het setup-token staat in de log).

**Zonder deze app:** `age -d -o backup.zip backup.zip.age` (of met `-i medialan.key`), uitpakken, en de JSON/CSV openen in elk programma, of `database.sqlite` met DB Browser for SQLite.

Overige commando's: `node src/backup/cli.ts backup` · `verify <zip>` · `test`.

---

## 5. Updaten

1. Push de nieuwe code naar GitHub (`git push`). GitHub test en bouwt automatisch een nieuw image.
2. Container Manager → **Image** → `ghcr.io/hendrilankamp/administratietool` → **Bijwerken** (verschijnt zodra er een nieuwe versie is). Lukt dat niet: Project `boekhouding` → Stoppen, het image verwijderen en het project opnieuw **Bouwen**; de nieuwste versie wordt dan opgehaald.
3. Bij een databasewijziging maakt de app bij het opstarten eerst automatisch een backup.

Elke versie krijgt ook een vaste tag (`sha-xxxxxxx`). Wil je terug naar een vorige versie, zet die tag dan in plaats van `latest` in het project.

---

## 6. Beveiliging in het kort

- Alleen bereikbaar vanaf het LAN of de VPN (geen poort open op de router). HTTPS via de DSM reverse proxy kan optioneel.
- Login met wachtwoord (min. 12 tekens, scrypt) en verplichte TOTP-2FA. Na 5 fouten volgt een blokkade van 15 minuten. Sessies verlopen na 30 minuten inactiviteit.
- CSRF-tokens op alle formulieren, strikte Content-Security-Policy, cookies `HttpOnly; SameSite=Strict` (en `Secure` zodra je via HTTPS werkt).
- API-sleutels en tokens staan versleuteld in de database (sleutel: `docker/boekhouding/app-secret`, alleen leesbaar voor de app) en worden nooit teruggetoond of gelogd.
- Uploads worden op inhoud gecontroleerd (alleen PDF/PNG/JPG, max. 20 MB) en opgeslagen onder hun sha256.
- De container draait na het opstarten als gewone gebruiker (niet root), met een read-only bestandssysteem, minimale rechten en `no-new-privileges`.
- Geboekte facturen kun je niet verwijderen. Afgesloten BTW-perioden zijn vergrendeld en elke wijziging komt in het audit-log.
- AI-voorstellen zijn alleen suggesties; boeken gebeurt altijd na jouw goedkeuring. Instructies die in een PDF staan, negeert de AI.

**Noodhulp** (Container Manager → Container → boekhouding → Terminal → Maken → `sh`):

```sh
node src/auth/cli.ts reset-2fa <gebruiker>   # nieuwe telefoon
node src/auth/cli.ts wachtwoord <gebruiker>  # wachtwoord vergeten
```

---

## 7. Projectstructuur

```
src/start.ts                   startpunt container (mapsrechten, root-rechten loslaten)
src/server.ts                  opstarten, planner (backup, Outlook, Mollie, AI, testherstel)
src/config.ts                  omgevingsvariabelen (allemaal optioneel)
src/lib/instellingen.ts        koppelingen uit de webinterface (versleuteld)
src/db/                        SQLite (node:sqlite) en migraties
src/lib/                       bedragen, datums, crypto/2FA, bijlagen, CSV, taken
src/modules/                   facturen, relaties, btw, bank, csv-import, rapportages
src/integrations/              outlook (Graph), mollie, ai (Claude)
src/backup/                    backup, rotatie, herstel, cli
src/web/                       Express-app, sessies/2FA, routes
src/views/, src/public/        EJS-templates, CSS en JS
test/                          node --test (incl. CSV-fixtures)
.github/workflows/image.yml    test + multi-arch image naar ghcr.io
```

**N26-formaat:** de app herkent zowel de huidige export (`Booking Date`, `Partner Name`, `Partner Iban`, `Amount (EUR)`, …) als het oudere formaat (`Date`, `Payee`, `Account number`, …). Wijkt jouw export af, koppel dan de kolommen in de importwizard en sla die koppeling op als profiel.
