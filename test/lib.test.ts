import { test } from "node:test";
import assert from "node:assert/strict";
import { berekenBtw, euro, invoerBedrag, parseBedrag } from "../src/lib/geld.ts";
import { kwartaalGrenzen, kwartaalVan, parseDatum } from "../src/lib/datum.ts";
import { controleerTotp, controleerWachtwoord, hashWachtwoord, nieuwTotpGeheim, ontsleutel, totpCode, versleutel } from "../src/lib/crypto.ts";
import { csvVeld } from "../src/lib/csv.ts";
import { teBewaren } from "../src/backup/rotatie.ts";

test("parseBedrag: Nederlandse en internationale notaties", () => {
  assert.equal(parseBedrag("1.234,56"), 123456);
  assert.equal(parseBedrag("1234,56"), 123456);
  assert.equal(parseBedrag("1234.56"), 123456);
  assert.equal(parseBedrag("1,234.56"), 123456);
  assert.equal(parseBedrag("-12,5"), -1250);
  assert.equal(parseBedrag("€ 10"), 1000);
  assert.equal(parseBedrag("1.234"), 123400);
  assert.equal(parseBedrag("12.50"), 1250);
  assert.equal(parseBedrag("(12.00)"), -1200);
  assert.equal(parseBedrag("12,345"), 1235);
  assert.equal(parseBedrag("-4.99", "."), -499);
  assert.equal(parseBedrag("1.000,00", ","), 100000);
  assert.equal(parseBedrag("abc"), null);
  assert.equal(parseBedrag(""), null);
  assert.equal(parseBedrag(-25.1), -2510);
});

test("bedragen formatteren", () => {
  assert.equal(euro(123456), "€ 1.234,56");
  assert.equal(invoerBedrag(-1250), "-12,50");
  assert.equal(invoerBedrag(5), "0,05");
});

test("BTW-berekening rondt per regel half van nul af", () => {
  assert.equal(berekenBtw(10000, 2100), 2100);
  assert.equal(berekenBtw(1250, 2100), 263); // 262,5 -> 263
  assert.equal(berekenBtw(-1250, 2100), -263);
  assert.equal(berekenBtw(999, 900), 90);
});

test("datums en kwartalen", () => {
  assert.equal(parseDatum("05-10-2026", "DD-MM-YYYY"), "2026-10-05");
  assert.equal(parseDatum("2026-2-3", "YYYY-MM-DD"), "2026-02-03");
  assert.equal(parseDatum("31-02-2026", "DD-MM-YYYY"), null);
  assert.deepEqual(kwartaalVan("2026-11-15"), { jaar: 2026, kwartaal: 4, id: "2026-Q4" });
  assert.deepEqual(kwartaalGrenzen(2024, 1), { van: "2024-01-01", tot: "2024-03-31" });
  assert.deepEqual(kwartaalGrenzen(2026, 4), { van: "2026-10-01", tot: "2026-12-31" });
});

test("wachtwoord-hash en versleuteling", () => {
  const h = hashWachtwoord("geheim wachtwoord");
  assert.ok(controleerWachtwoord("geheim wachtwoord", h));
  assert.ok(!controleerWachtwoord("fout", h));
  const blob = versleutel("token", "x".repeat(40), "msal");
  assert.equal(ontsleutel(blob, "x".repeat(40), "msal"), "token");
  assert.throws(() => ontsleutel(blob, "y".repeat(40), "msal"));
  assert.throws(() => ontsleutel(blob, "x".repeat(40), "ander-doel"));
});

test("TOTP volgens RFC 6238 testvector", () => {
  // RFC 6238 SHA-1 geheim "12345678901234567890" (base32), tijd 59 s -> 94287082 (8 cijfers) -> 287082 (6 cijfers)
  const geheim = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totpCode(geheim, 59_000), "287082");
  assert.equal(totpCode(geheim, 1111111109_000), "081804");
  const g = nieuwTotpGeheim();
  assert.ok(controleerTotp(g, totpCode(g)));
  assert.ok(!controleerTotp(g, "000000") || totpCode(g) === "000000");
});

test("CSV beschermt tegen formule-injectie", () => {
  assert.equal(csvVeld("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(csvVeld("a;b"), '"a;b"');
  assert.equal(csvVeld(-1250), "-1250");
  assert.equal(csvVeld('zeg "hoi"'), '"zeg ""hoi"""');
});

test("backuprotatie bewaart dag/week/maand/jaar", () => {
  const nu = new Date(2026, 9, 5, 12);
  const datums: Date[] = [];
  for (let i = 0; i < 800; i++) datums.push(new Date(2026, 9, 5 - i, 3));
  const bewaar = teBewaren(datums, nu);
  assert.ok(bewaar.size < 40, `te veel bewaard: ${bewaar.size}`);
  for (let i = 0; i < 7; i++) assert.ok(bewaar.has(i), `dag ${i} moet bewaard blijven`);
  // nieuwste van 2025 en 2024 blijven als jaarbackup
  const jaren = new Set([...bewaar].map((i) => datums[i].getFullYear()));
  assert.ok(jaren.has(2024) && jaren.has(2025));
});

test("perioden lezen en naar rato verdelen", async () => {
  const { parsePeriode, overlapFractie, maandGrenzen } = await import("../src/lib/datum.ts");
  assert.deepEqual(parsePeriode("01.09.2026 tot 01.10.2026"), { van: "2026-09-01", tot: "2026-09-30" });
  assert.deepEqual(parsePeriode("14.09.2026 tot 01.10.2026"), { van: "2026-09-14", tot: "2026-09-30" });
  assert.deepEqual(parsePeriode("01-01-2026 t/m 31-12-2026"), { van: "2026-01-01", tot: "2026-12-31" });
  assert.deepEqual(parsePeriode("02-2021 T/M 12-2021"), { van: "2021-02-01", tot: "2021-12-31" });
  assert.deepEqual(parsePeriode("september 2026"), { van: "2026-09-01", tot: "2026-09-30" });
  assert.deepEqual(parsePeriode("2026-01-01 - 2026-12-31"), { van: "2026-01-01", tot: "2026-12-31" });
  assert.equal(parsePeriode("onzin"), null);
  assert.deepEqual(maandGrenzen("2024-02"), { van: "2024-02-01", tot: "2024-02-29" });
  // Jaarfactuur 2026: Q1 = 90/365 deel
  assert.ok(Math.abs(overlapFractie("2026-01-01", "2026-03-31", "2026-01-01", "2026-12-31") - 90 / 365) < 1e-9);
  assert.equal(overlapFractie("2026-10-01", "2026-12-31", "2026-09-01", "2026-09-30"), 0);
  assert.equal(overlapFractie("2026-01-01", "2026-12-31", "2026-09-01", "2026-09-30"), 1);
});
