import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";
config({ path: ".env.local" });
import { getDatabase } from "../../src/db/client";
import { searchEverything } from "../../src/db/repository";
import { tokens } from "../../src/db/schema";

test("global search matches symbol, name and mint prefix, and treats % literally", async () => {
  const db = getDatabase(), tag = randomUUID().slice(0, 6).toUpperCase();
  const rows = await db.insert(tokens).values([
    { mint: `Srch${tag}111111111111111111111111111`, symbol: `ZQX${tag}`, name: "Search Probe One", status: "monitoring" },
    { mint: `Srch${tag}222222222222222222222222222`, symbol: `OTHER${tag}`, name: `Probe 100% ${tag}`, status: "eligible", archivedAt: new Date() },
  ]).returning({ id: tokens.id, mint: tokens.mint });
  try {
    assert.deepEqual((await searchEverything(`zqx${tag}`)).tokens.map((row) => row.mint), [rows[0].mint]);
    assert.equal((await searchEverything(`Srch${tag}`)).tokens.length, 2);
    // "%" must not act as a wildcard: only the token whose name literally contains "100%" matches.
    assert.deepEqual((await searchEverything(`100% ${tag}`)).tokens.map((row) => row.mint), [rows[1].mint]);
    assert.ok((await searchEverything(`OTHER${tag}`)).tokens[0].archivedAt, "archived tokens stay findable and are flagged");
    assert.equal((await searchEverything("z")).tokens.length, 0, "single-character queries are ignored");
  } finally { await db.delete(tokens).where(inArray(tokens.id, rows.map((row) => row.id))); }
});
