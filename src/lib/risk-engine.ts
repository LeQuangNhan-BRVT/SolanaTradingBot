import { z } from "zod";
import type { Candidate, CandidateStatus, RiskCheck } from "./types";

export type RiskLimits = { minimumMigrationHours: number; minimumLiquidityUsd: number; maximumCreatorClusterPct: number; maximumSuspectedBundlePct: number };
export const RISK_LIMITS: RiskLimits = { minimumMigrationHours: 4, minimumLiquidityUsd: 50_000, maximumCreatorClusterPct: 5, maximumSuspectedBundlePct: 10 };

// Thresholds are configurable within bounds; mint/freeze authority checks are not, and unknown data always blocks.
export const riskLimitsSchema = z.object({
  minimumMigrationHours: z.number({ invalid_type_error: "Tuổi migration phải là số." }).min(0, "Tuổi migration không được âm.").max(168, "Tuổi migration tối đa 168 giờ."),
  minimumLiquidityUsd: z.number({ invalid_type_error: "Thanh khoản phải là số." }).min(1_000, "Thanh khoản tối thiểu từ 1.000 USD.").max(10_000_000, "Thanh khoản tối đa 10.000.000 USD."),
  maximumCreatorClusterPct: z.number({ invalid_type_error: "Creator cluster phải là số." }).min(0, "Creator cluster không được âm.").max(50, "Creator cluster tối đa 50%."),
  maximumSuspectedBundlePct: z.number({ invalid_type_error: "Bundle phải là số." }).min(0, "Bundle không được âm.").max(80, "Bundle tối đa 80%."),
}).strict();

const makeCheck = (code: string, label: string, status: RiskCheck["status"], detail: string): RiskCheck => ({ code, label, status, detail, severity: "critical" });

export function assessCandidate(candidate: Candidate, mintAuthority: string | null, freezeAuthority: string | null, limits: RiskLimits = RISK_LIMITS) {
  const checks: RiskCheck[] = [
    makeCheck("mint_authority", "Quyền phát hành", mintAuthority === null ? "pass" : "fail", mintAuthority === null ? "Mint authority đã bị vô hiệu hóa." : `Mint authority vẫn hoạt động: ${mintAuthority}`),
    makeCheck("freeze_authority", "Quyền đóng băng", freezeAuthority === null ? "pass" : "fail", freezeAuthority === null ? "Freeze authority đã bị vô hiệu hóa." : `Freeze authority vẫn hoạt động: ${freezeAuthority}`),
    makeCheck("migration_age", "Tuổi migration", candidate.migratedHours === null ? "unknown" : candidate.migratedHours >= limits.minimumMigrationHours ? "pass" : "fail", candidate.migratedHours === null ? "Chưa xác minh transaction migration." : `Đã migration ${candidate.migratedHours.toFixed(1)} giờ (ngưỡng ${limits.minimumMigrationHours} giờ).`),
    makeCheck("liquidity", "Thanh khoản", candidate.liquidityUsd === null ? "unknown" : candidate.liquidityUsd >= limits.minimumLiquidityUsd ? "pass" : "fail", candidate.liquidityUsd === null ? "Chưa xác minh pool và thanh khoản." : `Thanh khoản $${candidate.liquidityUsd.toLocaleString("en-US")} (ngưỡng $${limits.minimumLiquidityUsd.toLocaleString("en-US")}).`),
    makeCheck("creator_cluster", "Creator cluster", candidate.clusterPct === null ? "unknown" : candidate.clusterPct <= limits.maximumCreatorClusterPct ? "pass" : "fail", candidate.clusterPct === null ? "Chưa hoàn thành truy vết creator/funder graph." : `Cluster đang nắm ${candidate.clusterPct}% (tối đa ${limits.maximumCreatorClusterPct}%).`),
    makeCheck("bundle", "Bundle nghi vấn", candidate.bundlePct === null ? "unknown" : candidate.bundlePct <= limits.maximumSuspectedBundlePct ? "pass" : "fail", candidate.bundlePct === null ? "Chưa đủ bằng chứng on-chain để phân loại bundle." : `Bundle nghi vấn ${candidate.bundlePct}% (tối đa ${limits.maximumSuspectedBundlePct}%).`),
  ];
  const hardFail = checks.some((item) => item.status === "fail");
  const incomplete = checks.some((item) => item.status === "unknown");
  const status: CandidateStatus = hardFail ? "rejected" : incomplete ? "monitoring" : "eligible";
  const riskScore = Math.min(100, checks.reduce((score, item) => score + (item.status === "fail" ? 30 : item.status === "unknown" ? 10 : 0), 0));
  return { checks, status, riskScore };
}
