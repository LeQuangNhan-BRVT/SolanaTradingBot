import { Dashboard } from "@/components/dashboard";
import { hasDatabase } from "@/db/client";
import { getTradingControls, listCandidates } from "@/db/repository";
export const dynamic = "force-dynamic";
export default async function Home(){const connected=hasDatabase();const [candidates,controls]=connected?await Promise.all([listCandidates().catch(error=>{console.error("Database read failed",error);return []}),getTradingControls()]):[[],{entriesPaused:true}];return <Dashboard candidates={candidates} databaseConnected={connected} entriesPaused={controls.entriesPaused}/>}
