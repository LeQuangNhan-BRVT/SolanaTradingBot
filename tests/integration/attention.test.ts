import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { eq } from "drizzle-orm";
config({ path: ".env.local" });
import { getDatabase } from "../../src/db/client";
import { getAttentionData } from "../../src/db/repository";
import { orders, pools, tokens, triggerOrders } from "../../src/db/schema";

test("attention data picks up fired live alerts, recent failures and crossed price alerts", async () => {
  const db = getDatabase(), tag = randomUUID().slice(0, 8);
  const [token] = await db.insert(tokens).values({ mint: `Attn${tag}11111111111111111111111111`, symbol: `ATT${tag}`, name: "Attention Probe", status: "monitoring", alertPriceAboveUsd: "0.01" }).returning({ id: tokens.id, mint: tokens.mint });
  try {
    await db.insert(pools).values({ tokenId: token.id, address: `AttnPool${tag}1111111111111111111111`, dex: "test", quoteMint: "So11111111111111111111111111111111111111112", priceUsd: "0.02", liquidityUsd: "1000" });
    const [alert] = await db.insert(triggerOrders).values({ tokenId: token.id, mode: "live", type: "stop_loss", status: "triggered", triggerMcapUsd: "1000", sellPctBps: 10_000, triggeredAt: new Date() }).returning({ id: triggerOrders.id });
    const [failed] = await db.insert(orders).values({ tokenId: token.id, mode: "shadow", side: "buy", status: "failed", idempotencyKey: `attn-${tag}`, requestedAmountRaw: "1000", error: "probe failure" }).returning({ id: orders.id });
    const data = await getAttentionData();
    assert.ok(data.triggeredAlerts.some((row) => row.id === alert.id));
    assert.ok(data.failedOrders.some((row) => row.id === failed.id && row.error === "probe failure"));
    const price = data.priceAlerts.find((row) => row.mint === token.mint);
    assert.equal(price?.alertPriceAboveUsd, "0.010000000000000000");
    assert.equal(Number(price?.priceUsd), 0.02);
  } finally {
    await db.delete(triggerOrders).where(eq(triggerOrders.tokenId, token.id));
    await db.delete(orders).where(eq(orders.tokenId, token.id));
    await db.delete(pools).where(eq(pools.tokenId, token.id));
    await db.delete(tokens).where(eq(tokens.id, token.id));
  }
});
