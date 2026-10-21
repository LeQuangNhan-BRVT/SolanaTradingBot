import { getShadowSettings, listOpenPositionsForPricing } from "@/db/repository";
import { estimatePositionPnlBps, shouldCheckExit } from "./live-safety";
import { fetchJupiterPrices } from "./price-feed";
import { WSOL_MINT } from "./wallet-tracker";

export type ExitCheckRequest = { mode: "shadow" | "live"; positionId: string; estimatedPnlBps: number };

// Cheap price poll for open positions of the active mode. Positions near a threshold are handed to the exact quote-based exit check.
export async function scanPricesForExits(requestExitCheck: (request: ExitCheckRequest) => Promise<void>) {
  const mode = process.env.TRADING_MODE ?? "paper";
  if (mode !== "shadow" && mode !== "live") return { checked: 0, triggered: 0 };
  const positions = (await listOpenPositionsForPricing()).filter((item) => item.mode === mode && item.decimals !== null);
  if (positions.length === 0) return { checked: 0, triggered: 0 };
  const [prices, settings] = await Promise.all([fetchJupiterPrices([WSOL_MINT, ...positions.map((item) => item.mint)]), getShadowSettings()]);
  const solUsd = prices.get(WSOL_MINT);
  if (!solUsd) throw new Error("Jupiter price missing for SOL.");
  let triggered = 0;
  for (const position of positions) {
    const tokenUsd = prices.get(position.mint);
    if (tokenUsd === undefined) continue;
    const estimated = estimatePositionPnlBps({ quantityRaw: position.quantityRaw, decimals: position.decimals!, costLamports: position.costLamports, tokenUsd, solUsd });
    if (estimated === null || !shouldCheckExit(estimated, settings)) continue;
    triggered++;
    await requestExitCheck({ mode, positionId: position.id, estimatedPnlBps: estimated });
  }
  return { checked: positions.length, triggered };
}
