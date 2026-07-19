import { bigint, boolean, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { RiskCheck } from "@/lib/types";

export const candidateStatus = pgEnum("candidate_status", ["monitoring", "eligible", "rejected"]);
export const orderSide = pgEnum("order_side", ["buy", "sell"]);
export const orderStatus = pgEnum("order_status", ["created", "quoted", "simulated", "submitted", "confirmed", "failed", "cancelled"]);
export const positionStatus = pgEnum("position_status", ["open", "closing", "closed"]);
export const tradingMode = pgEnum("trading_mode", ["paper", "shadow", "live"]);

const timestamps = { createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull() };

export const tokens = pgTable("tokens", {
  id: uuid("id").defaultRandom().primaryKey(), mint: text("mint").notNull(), symbol: text("symbol").notNull().default("—"), name: text("name").notNull().default("Token chưa nhận diện"), launchpad: text("launchpad").notNull().default("Unknown"), tokenProgram: text("token_program"), decimals: integer("decimals"), supplyRaw: numeric("supply_raw", { precision: 78, scale: 0 }), mintAuthority: text("mint_authority"), freezeAuthority: text("freeze_authority"), status: candidateStatus("status").notNull().default("monitoring"), riskScore: integer("risk_score").notNull().default(0), ...timestamps,
}, (table) => [uniqueIndex("tokens_mint_unique").on(table.mint), index("tokens_status_idx").on(table.status)]);

export const wallets = pgTable("wallets", { id: uuid("id").defaultRandom().primaryKey(), address: text("address").notNull(), label: text("label"), ...timestamps }, table => [uniqueIndex("wallets_address_unique").on(table.address)]);
export const tokenCreators = pgTable("token_creators", { id: uuid("id").defaultRandom().primaryKey(), tokenId: uuid("token_id").notNull().references(() => tokens.id), creatorWalletId: uuid("creator_wallet_id").notNull().references(() => wallets.id), userWalletId: uuid("user_wallet_id").notNull().references(() => wallets.id), feePayerWalletId: uuid("fee_payer_wallet_id").notNull().references(() => wallets.id), signature: text("signature").notNull(), slot: bigint("slot", { mode: "bigint" }).notNull(), blockTime: timestamp("block_time", { withTimezone: true }).notNull(), instruction: text("instruction").notNull(), verified: boolean("verified").notNull().default(true), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() }, table => [uniqueIndex("token_creators_token_unique").on(table.tokenId), uniqueIndex("token_creators_signature_unique").on(table.signature)]);

export const pools = pgTable("pools", {
  id: uuid("id").defaultRandom().primaryKey(), tokenId: uuid("token_id").notNull().references(() => tokens.id), address: text("address").notNull(), dex: text("dex").notNull(), quoteMint: text("quote_mint").notNull(), liquidityUsd: numeric("liquidity_usd", { precision: 24, scale: 8 }), volume1hUsd: numeric("volume_1h_usd", { precision: 24, scale: 8 }), volume24hUsd: numeric("volume_24h_usd", { precision: 24, scale: 8 }), priceChange1h: numeric("price_change_1h", { precision: 16, scale: 8 }), pairCreatedAt: timestamp("pair_created_at", { withTimezone: true }), verified: boolean("verified").notNull().default(false), ...timestamps,
}, (table) => [uniqueIndex("pools_address_unique").on(table.address), index("pools_token_idx").on(table.tokenId)]);

export const migrationEvents = pgTable("migration_events", {
  id: uuid("id").defaultRandom().primaryKey(), tokenId: uuid("token_id").notNull().references(() => tokens.id), poolId: uuid("pool_id").references(() => pools.id), signature: text("signature").notNull(), slot: bigint("slot", { mode: "bigint" }).notNull(), blockTime: timestamp("block_time", { withTimezone: true }).notNull(), verified: boolean("verified").notNull().default(false), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("migration_signature_unique").on(table.signature), index("migration_token_time_idx").on(table.tokenId, table.blockTime)]);

export const riskAssessments = pgTable("risk_assessments", {
  id: uuid("id").defaultRandom().primaryKey(), tokenId: uuid("token_id").notNull().references(() => tokens.id), version: integer("version").notNull(), status: candidateStatus("status").notNull(), score: integer("score").notNull(), creatorClusterPct: numeric("creator_cluster_pct", { precision: 8, scale: 4 }), suspectedBundlePct: numeric("suspected_bundle_pct", { precision: 8, scale: 4 }), checks: jsonb("checks").$type<RiskCheck[]>().notNull(), assessedAt: timestamp("assessed_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("risk_token_version_unique").on(table.tokenId, table.version), index("risk_token_assessed_idx").on(table.tokenId, table.assessedAt)]);

export const signals = pgTable("signals", {
  id: uuid("id").defaultRandom().primaryKey(), tokenId: uuid("token_id").notNull().references(() => tokens.id), riskAssessmentId: uuid("risk_assessment_id").notNull().references(() => riskAssessments.id), strategyVersion: text("strategy_version").notNull(), idempotencyKey: text("idempotency_key").notNull(), score: numeric("score", { precision: 12, scale: 6 }).notNull(), payload: jsonb("payload").$type<Record<string, unknown>>().notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("signals_idempotency_unique").on(table.idempotencyKey), index("signals_token_created_idx").on(table.tokenId, table.createdAt)]);

export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(), signalId: uuid("signal_id").references(() => signals.id), tokenId: uuid("token_id").notNull().references(() => tokens.id), mode: tradingMode("mode").notNull().default("paper"), side: orderSide("side").notNull(), status: orderStatus("status").notNull().default("created"), idempotencyKey: text("idempotency_key").notNull(), requestedAmountRaw: numeric("requested_amount_raw", { precision: 78, scale: 0 }).notNull(), quoteRaw: jsonb("quote_raw").$type<Record<string, unknown>>(), signature: text("signature"), error: text("error"), ...timestamps,
}, (table) => [uniqueIndex("orders_idempotency_unique").on(table.idempotencyKey), uniqueIndex("orders_signature_unique").on(table.signature), index("orders_status_created_idx").on(table.status, table.createdAt)]);

export const fills = pgTable("fills", {
  id: uuid("id").defaultRandom().primaryKey(), orderId: uuid("order_id").notNull().references(() => orders.id), signature: text("signature").notNull(), baseAmountRaw: numeric("base_amount_raw", { precision: 78, scale: 0 }).notNull(), quoteAmountRaw: numeric("quote_amount_raw", { precision: 78, scale: 0 }).notNull(), feeLamports: numeric("fee_lamports", { precision: 30, scale: 0 }).notNull().default("0"), slot: bigint("slot", { mode: "bigint" }), filledAt: timestamp("filled_at", { withTimezone: true }).notNull(),
}, (table) => [uniqueIndex("fills_signature_order_unique").on(table.signature, table.orderId), index("fills_order_idx").on(table.orderId)]);

export const positions = pgTable("positions", {
  id: uuid("id").defaultRandom().primaryKey(), tokenId: uuid("token_id").notNull().references(() => tokens.id), mode: tradingMode("mode").notNull(), status: positionStatus("status").notNull().default("open"), quantityRaw: numeric("quantity_raw", { precision: 78, scale: 0 }).notNull(), costLamports: numeric("cost_lamports", { precision: 30, scale: 0 }).notNull(), realizedPnlLamports: numeric("realized_pnl_lamports", { precision: 30, scale: 0 }).notNull().default("0"), openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(), closedAt: timestamp("closed_at", { withTimezone: true }), ...timestamps,
}, (table) => [index("positions_token_status_idx").on(table.tokenId, table.status), index("positions_mode_status_idx").on(table.mode, table.status)]);

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(), eventType: text("event_type").notNull(), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(), payload: jsonb("payload").$type<Record<string, unknown>>().notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("audit_entity_idx").on(table.entityType, table.entityId, table.createdAt)]);
