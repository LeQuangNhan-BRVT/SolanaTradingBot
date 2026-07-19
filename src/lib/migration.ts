import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const MIGRATE_DISCRIMINATOR = Buffer.from([155, 234, 231, 146, 236, 158, 162, 30]);
const MIGRATE_V2_DISCRIMINATOR = Buffer.from([187, 203, 18, 31, 206, 237, 254, 41]);

export type MigrationInspection = { signature: string; slot: bigint; blockTime: Date; poolAddress: string; verified: true };

function addressOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "toBase58" in value && typeof value.toBase58 === "function") return value.toBase58();
  return null;
}

function matchesMigrateInstruction(instruction: unknown, mint: string, pool: string): boolean {
  if (!instruction || typeof instruction !== "object" || !("accounts" in instruction) || !("programId" in instruction) || !("data" in instruction)) return false;
  const candidate = instruction as { accounts: unknown[]; programId: unknown; data: string };
  if (addressOf(candidate.programId) !== PUMP_PROGRAM.toBase58() || typeof candidate.data !== "string") return false;
  const data = Buffer.from(bs58.decode(candidate.data));
  const legacy = data.subarray(0, 8).equals(MIGRATE_DISCRIMINATOR);
  const v2 = data.subarray(0, 8).equals(MIGRATE_V2_DISCRIMINATOR);
  if (!legacy && !v2) return false;
  const ammIndex = legacy ? 8 : 9;
  const poolIndex = legacy ? 9 : 10;
  return addressOf(candidate.accounts[2]) === mint && addressOf(candidate.accounts[ammIndex]) === PUMP_AMM_PROGRAM && addressOf(candidate.accounts[poolIndex]) === pool;
}

async function verifyWithHelius(mint: string, pool: string, pairCreatedAt: Date): Promise<MigrationInspection | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;
  const center = Math.floor(pairCreatedAt.getTime() / 1000);
  const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: "aegis-migration", method: "getTransactionsForAddress", params: [pool, { transactionDetails: "full", encoding: "jsonParsed", maxSupportedTransactionVersion: 0, sortOrder: "asc", limit: 1000, filters: { blockTime: { gte: center - 1800, lte: center + 1800 }, status: "succeeded" } }] }),
  });
  if (!response.ok) throw new Error(`Helius historical API HTTP ${response.status}`);
  const payload = await response.json() as { error?: { message?: string }; result?: { data?: Array<Record<string, unknown>> } };
  if (payload.error) throw new Error(payload.error.message ?? "Helius historical API error");
  for (const record of payload.result?.data ?? []) {
    const transaction = record.transaction as { signatures?: string[]; message?: { instructions?: unknown[] } } | undefined;
    const meta = record.meta as { innerInstructions?: Array<{ instructions?: unknown[] }> } | undefined;
    const instructions = [...(transaction?.message?.instructions ?? []), ...(meta?.innerInstructions?.flatMap((group) => group.instructions ?? []) ?? [])];
    if (!instructions.some((instruction) => matchesMigrateInstruction(instruction, mint, pool))) continue;
    const signature = typeof record.signature === "string" ? record.signature : transaction?.signatures?.[0];
    const slot = typeof record.slot === "number" ? record.slot : null;
    const blockTime = typeof record.blockTime === "number" ? record.blockTime : null;
    if (signature && slot !== null && blockTime !== null) return { signature, slot: BigInt(slot), blockTime: new Date(blockTime * 1000), poolAddress: pool, verified: true };
  }
  return null;
}

export async function verifyPumpMigration(mintAddress: string, poolAddress: string, pairCreatedAt: Date | null): Promise<MigrationInspection | null> {
  if (!pairCreatedAt) return null;
  const indexed = await verifyWithHelius(mintAddress, poolAddress, pairCreatedAt);
  if (indexed) return indexed;
  const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const pool = new PublicKey(poolAddress);
  const mint = new PublicKey(mintAddress);
  const lower = Math.floor((pairCreatedAt.getTime() - 30 * 60_000) / 1000);
  const upper = Math.floor((pairCreatedAt.getTime() + 30 * 60_000) / 1000);
  const candidates: { signature: string; slot: number; blockTime: number | null }[] = [];
  let before: string | undefined;

  // Signature pages are cheap compared with parsed transactions. High-volume
  // pools can exceed 10k swaps within days, so page until the creation window.
  for (let page = 0; page < 50; page++) {
    const signatures = await connection.getSignaturesForAddress(pool, { before, limit: 1000 }, "confirmed");
    if (!signatures.length) break;
    for (const item of signatures) if (item.err === null && typeof item.blockTime === "number" && item.blockTime >= lower && item.blockTime <= upper) candidates.push({ signature: item.signature, slot: item.slot, blockTime: item.blockTime });
    const oldest = signatures[signatures.length - 1];
    if (typeof oldest.blockTime === "number" && oldest.blockTime < lower) break;
    before = oldest.signature;
  }

  for (let offset = 0; offset < candidates.length; offset += 100) {
    const batch = candidates.slice(offset, offset + 100);
    const transactions = await connection.getParsedTransactions(batch.map((item) => item.signature), { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    for (let index = 0; index < transactions.length; index++) {
      const transaction = transactions[index];
      if (!transaction || transaction.meta?.err) continue;
      const allInstructions = [
        ...transaction.transaction.message.instructions,
        ...(transaction.meta?.innerInstructions?.flatMap((group) => group.instructions) ?? []),
      ];
      for (const instruction of allInstructions) {
        if (!("accounts" in instruction) || !instruction.programId.equals(PUMP_PROGRAM)) continue;
        if (!matchesMigrateInstruction(instruction, mint.toBase58(), pool.toBase58())) continue;
        const item = batch[index];
        const blockTime = transaction.blockTime ?? item.blockTime;
        if (blockTime === null) continue;
        return { signature: item.signature, slot: BigInt(transaction.slot), blockTime: new Date(blockTime * 1000), poolAddress, verified: true };
      }
    }
  }
  return null;
}
