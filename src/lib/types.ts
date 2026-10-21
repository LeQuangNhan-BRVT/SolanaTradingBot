export type CandidateStatus = "eligible" | "monitoring" | "rejected";
export type CheckStatus = "pass" | "fail" | "unknown";
export type RiskCheck = { code: string; label: string; status: CheckStatus; severity: "info" | "warning" | "critical"; detail: string };
export type MintInspection = { mint: string; tokenProgram: string; decimals: number; supplyRaw: string; mintAuthority: string | null; freezeAuthority: string | null; inspectedAt: string };
export type Candidate = { mint: string; symbol: string; name: string; launchpad: "Pump.fun" | "BONK" | "Unknown"; migratedHours: number | null; riskScore: number; bundlePct: number | null; clusterPct: number | null; liquidityUsd: number | null; volume1hUsd: number | null; priceChange1h: number | null; status: CandidateStatus; creator?: string | null; checks?: RiskCheck[]; priceUsd?: string | null; watch?: WatchState };
export type WatchState = { note: string | null; tags: string[]; pinned: boolean; archived: boolean; autoTrade: boolean };
export type CandidateAssessment = { candidate: Candidate; mint: MintInspection; checks: RiskCheck[]; summary: string };
