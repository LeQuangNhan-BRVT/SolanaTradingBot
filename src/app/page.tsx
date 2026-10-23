import { Dashboard } from "@/components/dashboard";
import { hasDatabase } from "@/db/client";
import { getAttentionData, getTradingControls, listCandidates } from "@/db/repository";
import { buildAttentionItems } from "@/lib/attention";
export const dynamic = "force-dynamic";
export default async function Home({ searchParams }: { searchParams: Promise<{ view?: string; tag?: string }> }) {
  const { view, tag } = await searchParams;
  const archived = view === "archived", connected = hasDatabase();
  const [candidates, controls, attention] = connected ? await Promise.all([listCandidates({ archived }).catch(error => { console.error("Database read failed", error); return []; }), getTradingControls(), getAttentionData().then(buildAttentionItems).catch(error => { console.error("Attention read failed", error); return []; })]) : [[], { entriesPaused: true, haltAll: false }, []];
  return <Dashboard candidates={candidates} attention={attention} databaseConnected={connected} entriesPaused={controls.entriesPaused} haltAll={controls.haltAll} mode={process.env.TRADING_MODE ?? "paper"} archived={archived} activeTag={tag ?? null}/>;
}
