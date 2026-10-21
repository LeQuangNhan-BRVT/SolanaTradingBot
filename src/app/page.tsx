import { Dashboard } from "@/components/dashboard";
import { hasDatabase } from "@/db/client";
import { getTradingControls, listCandidates } from "@/db/repository";
export const dynamic = "force-dynamic";
export default async function Home({ searchParams }: { searchParams: Promise<{ view?: string; tag?: string }> }) {
  const { view, tag } = await searchParams;
  const archived = view === "archived", connected = hasDatabase();
  const [candidates, controls] = connected ? await Promise.all([listCandidates({ archived }).catch(error => { console.error("Database read failed", error); return []; }), getTradingControls()]) : [[], { entriesPaused: true }];
  return <Dashboard candidates={candidates} databaseConnected={connected} entriesPaused={controls.entriesPaused} archived={archived} activeTag={tag ?? null}/>;
}
