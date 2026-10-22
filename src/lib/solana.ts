import { Connection, PublicKey } from "@solana/web3.js";
import type { MintInspection } from "./types";

// Solana now emits version 1 transactions; RPC rejects them when a lower maximum is requested.
export const MAX_SUPPORTED_TX_VERSION = 1;

export class MintValidationError extends Error {}

export async function inspectMint(address: string): Promise<MintInspection> {
  let mint: PublicKey;
  try { mint = new PublicKey(address); } catch { throw new MintValidationError("CA Solana không hợp lệ."); }
  const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const account = await connection.getParsedAccountInfo(mint, "confirmed");
  if (!account.value) throw new MintValidationError("Không tìm thấy tài khoản mint trên mainnet.");
  if (!("parsed" in account.value.data) || account.value.data.parsed.type !== "mint") throw new MintValidationError("Địa chỉ tồn tại nhưng không phải SPL Token mint.");
  const info = account.value.data.parsed.info as { decimals: number; supply: string; mintAuthority: string | null; freezeAuthority: string | null };
  return { mint: mint.toBase58(), tokenProgram: account.value.owner.toBase58(), decimals: info.decimals, supplyRaw: info.supply, mintAuthority: info.mintAuthority, freezeAuthority: info.freezeAuthority, inspectedAt: new Date().toISOString() };
}

export async function fetchTokenSupply(address: string) {
  const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
  return (await connection.getTokenSupply(new PublicKey(address), "confirmed")).value.amount;
}
