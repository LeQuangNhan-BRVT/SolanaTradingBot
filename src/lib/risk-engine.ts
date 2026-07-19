import type { Candidate, CandidateStatus, RiskCheck } from "./types";

export const RISK_LIMITS = { minimumMigrationHours: 4, minimumLiquidityUsd: 50_000, maximumCreatorClusterPct: 5, maximumSuspectedBundlePct: 10 } as const;

const makeCheck = (code: string, label: string, status: RiskCheck["status"], detail: string): RiskCheck => ({ code, label, status, detail, severity: "critical" });

export function assessCandidate(candidate: Candidate, mintAuthority: string | null, freezeAuthority: string | null) {
  const checks: RiskCheck[] = [
    makeCheck("mint_authority", "Quyền phát hành", mintAuthority === null ? "pass" : "fail", mintAuthority === null ? "Mint authority đã bị vô hiệu hóa." : `Mint authority vẫn hoạt động: ${mintAuthority}`),
    makeCheck("freeze_authority", "Quyền đóng băng", freezeAuthority === null ? "pass" : "fail", freezeAuthority === null ? "Freeze authority đã bị vô hiệu hóa." : `Freeze authority vẫn hoạt động: ${freezeAuthority}`),
    makeCheck("migration_age", "Tuổi migration", candidate.migratedHours === null ? "unknown" : candidate.migratedHours >= RISK_LIMITS.minimumMigrationHours ? "pass" : "fail", candidate.migratedHours === null ? "Chưa xác minh transaction migration." : `Đã migration ${candidate.migratedHours.toFixed(1)} giờ.`),
    makeCheck("liquidity", "Thanh khoản", candidate.liquidityUsd === null ? "unknown" : candidate.liquidityUsd >= RISK_LIMITS.minimumLiquidityUsd ? "pass" : "fail", candidate.liquidityUsd === null ? "Chưa xác minh pool và thanh khoản." : `Thanh khoản $${candidate.liquidityUsd.toLocaleString("en-US")}.`),
    makeCheck("creator_cluster", "Creator cluster", candidate.clusterPct === null ? "unknown" : candidate.clusterPct <= RISK_LIMITS.maximumCreatorClusterPct ? "pass" : "fail", candidate.clusterPct === null ? "Chưa hoàn thành truy vết creator/funder graph." : `Cluster đang nắm ${candidate.clusterPct}%.`),
    makeCheck("bundle", "Bundle nghi vấn", candidate.bundlePct === null ? "unknown" : candidate.bundlePct <= RISK_LIMITS.maximumSuspectedBundlePct ? "pass" : "fail", candidate.bundlePct === null ? "Chưa đủ bằng chứng on-chain để phân loại bundle." : `Bundle nghi vấn ${candidate.bundlePct}%.`),
  ];
  const hardFail = checks.some((item) => item.status === "fail");
  const incomplete = checks.some((item) => item.status === "unknown");
  const status: CandidateStatus = hardFail ? "rejected" : incomplete ? "monitoring" : "eligible";
  const riskScore = Math.min(100, checks.reduce((score, item) => score + (item.status === "fail" ? 30 : item.status === "unknown" ? 10 : 0), 0));
  return { checks, status, riskScore };
}
