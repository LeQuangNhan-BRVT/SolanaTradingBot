import { Dashboard } from "@/components/dashboard";
import { hasDatabase } from "@/db/client";
import { listCandidates } from "@/db/repository";
export const dynamic = "force-dynamic";
export default async function Home(){const connected=hasDatabase();const candidates=connected?await listCandidates().catch(error=>{console.error("Database read failed",error);return []}):[];return <Dashboard candidates={candidates} databaseConnected={connected}/>}
