import test from "node:test";
import assert from "node:assert/strict";
import { computeCreatorCluster, type HolderGraph, type HolderNode } from "../src/lib/graph";
import { inspectBundle } from "../src/lib/bundle";

const holder = (owner: string, percentage: number, funder: string | null): HolderNode => ({ rank: 1, tokenAccount: `${owner}-ata`, owner, amountRaw: "1", percentage, excluded: false, exclusionReason: null, funding: funder ? { from: funder, to: owner, signature: "sig", slot: 1n, blockTime: new Date(0), lamports: "1" } : null });
const graph = (fundingComplete: boolean): HolderGraph => ({ slot: 1n, supplyRaw: "100", holders: [holder("a", 3, "f")], creatorClusterPct: null, creatorFunder: "f", fundingComplete });

test("cluster is unknown when funding data is incomplete", () => {
  assert.equal(computeCreatorCluster([holder("a", 3, "f")], ["creator"], "f", false), null);
});

test("cluster is unknown when creator funder cannot be traced", () => {
  assert.equal(computeCreatorCluster([holder("a", 3, "f")], ["creator"], null, true), null);
});

test("cluster sums holders sharing the creator funder", () => {
  assert.equal(computeCreatorCluster([holder("a", 3, "f"), holder("b", 2, "other"), holder("creator", 1.5, null)], ["creator"], "f", true), 4.5);
});

test("bundle coverage is incomplete without Helius key", async () => {
  const previous = process.env.HELIUS_API_KEY;
  delete process.env.HELIUS_API_KEY;
  try { assert.equal((await inspectBundle("mint", graph(true), new Date(0), new Date(1))).truncated, true); }
  finally { if (previous !== undefined) process.env.HELIUS_API_KEY = previous; }
});

test("bundle coverage is incomplete when funding graph is incomplete", async () => {
  const previous = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = "test-key";
  try { assert.equal((await inspectBundle("mint", graph(false), new Date(0), new Date(1))).truncated, true); }
  finally { if (previous === undefined) delete process.env.HELIUS_API_KEY; else process.env.HELIUS_API_KEY = previous; }
});
