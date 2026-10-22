import { getShadowSettings, listActiveTriggersForPricing, listOpenPositionsForPricing, sweepTriggerOrders } from "@/db/repository";
import { estimatePositionPnlBps, shouldCheckExit } from "./live-safety";
import { fetchJupiterPrices } from "./price-feed";
import { scanTriggerOrders, triggersEnabled } from "./trigger-engine";
import { WSOL_MINT } from "./wallet-tracker";

export type ExitCheckRequest = { mode: "shadow" | "live"; positionId: string; estimatedPnlBps: number };
type OpenPosition = Awaited<ReturnType<typeof listOpenPositionsForPricing>>[number];

// Cheap price estimate for bot-opened positions; those near a threshold are handed to the exact quote-based exit check.
export async function scanPricesForExits(positions: OpenPosition[], prices: Map<string, number>, requestExitCheck: (request: ExitCheckRequest) => Promise<void>) {
  const solUsd = prices.get(WSOL_MINT);
  if (positions.length === 0) return { checked: 0, triggered: 0 };
  if (!solUsd) throw new Error("Jupiter price missing for SOL.");
  const settings = await getShadowSettings();
  let triggered = 0;
  for (const position of positions) {
    const tokenUsd = prices.get(position.mint);
    if (tokenUsd === undefined || position.decimals === null) continue;
    const estimated = estimatePositionPnlBps({ quantityRaw: position.quantityRaw, decimals: position.decimals, costLamports: position.costLamports, tokenUsd, solUsd });
    if (estimated === null || !shouldCheckExit(estimated, settings)) continue;
    triggered++;
    await requestExitCheck({ mode: position.mode as "shadow" | "live", positionId: position.id, estimatedPnlBps: estimated });
  }
  return { checked: positions.length, triggered };
}

// One Jupiter price request per tick serves both automated exits and trigger orders (keyless limit ≈0.5 req/s).
export async function runPriceLoop(handlers: { requestExitCheck: (request: ExitCheckRequest) => Promise<void>; requestTriggerExecute: (triggerId: string) => Promise<void> }) {
  const mode = process.env.TRADING_MODE ?? "paper";
  const positions = mode === "shadow" || mode === "live" ? (await listOpenPositionsForPricing()).filter((item) => item.mode === mode) : [];
  let triggers: Awaited<ReturnType<typeof listActiveTriggersForPricing>> = [];
  // Shadow triggers simulate fills only in shadow mode; live alert-only triggers (browser-wallet positions) always run.
  await sweepTriggerOrders();
  triggers = await listActiveTriggersForPricing(triggersEnabled() ? ["shadow", "live"] : ["live"]);
  if (positions.length === 0 && triggers.length === 0) return { exits: { checked: 0, triggered: 0 }, triggers: { checked: 0, fired: 0 } };
  const prices = await fetchJupiterPrices([WSOL_MINT, ...positions.map((item) => item.mint), ...triggers.map((item) => item.mint)]);
  return {
    exits: await scanPricesForExits(positions, prices, handlers.requestExitCheck),
    triggers: await scanTriggerOrders(triggers, prices, handlers.requestTriggerExecute),
  };
}
