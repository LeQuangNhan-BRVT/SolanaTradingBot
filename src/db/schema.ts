import { bigint, boolean, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { RiskCheck } from "@/lib/types";

export const candidateStatus = pgEnum("candidate_status", ["monitoring", "eligible", "rejected"]);
export const orderSide = pgEnum("order_side", ["buy", "sell"]);
export const orderStatus = pgEnum("order_status", ["created", "quoted", "simulated", "submitted", "confirmed", "failed", "cancelled"]);
export const positionStatus = pgEnum("position_status", ["open", "closing", "closed"]);
export const tradingMode = pgEnum("trading_mode", ["paper", "shadow", "live"]);
export const triggerType = pgEnum("trigger_type", ["limit_buy", "take_profit", "stop_loss", "trailing_stop"]);
export const triggerStatus = pgEnum("trigger_status", ["active", "triggered", "filled", "cancelled", "expired", "failed"]);

export const runtimeSettings = pgTable("runtime_settings", { key: text("key").primaryKey(), value: jsonb("value").$type<Record<string, unknown>>().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull() });

const timestamps = { createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull() };

export const tokens = pgTable("tokens", {
  id: uuid("id").defaultRandom().primaryKey(), mint: text("mint").notNull(), symbol: text("symbol").notNull().default("—"), name: text("name").notNull().default("Token chưa nhận diện"), launchpad: text("launchpad").notNull().default("Unknown"), tokenProgram: text("token_program"), decimals: integer("decimals"), supplyRaw: numeric("supply_raw", { precision: 78, scale: 0 }), mintAuthority: text("mint_authority"), freezeAuthority: text("freeze_authority"), status: candidateStatus("status").notNull().default("monitoring"), riskScore: integer("risk_score").notNull().default(0),
  watchNote: text("watch_note"), watchTags: jsonb("watch_tags").$type<string[]>().notNull().default([]), pinned: boolean("pinned").notNull().default(false), archivedAt: timestamp("archived_at", { withTimezone: true }), autoTrade: boolean("auto_trade").notNull().default(false),
  alertPriceAboveUsd: numeric("alert_price_above_usd", { precision: 38, scale: 18 }), alertPriceBelowUsd: numeric("alert_price_below_usd", { precision: 38, scale: 18 }), alertChange1hPct: numeric("alert_change_1h_pct", { precision: 10, scale: 4 }), ...timestamps,
}, (table) => [uniqueIndex("tokens_mint_unique").on(table.mint), index("tokens_status_idx").on(table.status)]);

export const trackedWallets = pgTable("tracked_wallets", { id: uuid("id").defaultRandom().primaryKey(), address: text("address").notNull(), label: text("label"), ...timestamps }, table => [uniqueIndex("tracked_wallets_address_unique").on(table.address)]);
export const wallets = pgTable("wallets", { id: uuid("id").defaultRandom().primaryKey(), address: text("address").notNull(), label: text("label"), ...timestamps }, table => [uniqueIndex("wallets_address_unique").on(table.address)]);
export const tokenCreators = pgTable("token_creators", { id: uuid("id").defaultRandom().primaryKey(), tokenId: uuid("token_id").notNull().references(() => tokens.id), creatorWalletId: uuid("creator_wallet_id").notNull().references(() => wallets.id), userWalletId: uuid("user_wallet_id").notNull().references(() => wallets.id), feePayerWalletId: uuid("fee_payer_wallet_id").notNull().references(() => wallets.id), signature: text("signature").notNull(), slot: bigint("slot", { mode: "bigint" }).notNull(), blockTime: timestamp("block_time", { withTimezone: true }).notNull(), instruction: text("instruction").notNull(), verified: boolean("verified").notNull().default(true), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() }, table => [uniqueIndex("token_creators_token_unique").on(table.tokenId), uniqueIndex("token_creators_signature_unique").on(table.signature)]);

export const walletFundingEdges = pgTable("wallet_funding_edges", { id:uuid("id").defaultRandom().primaryKey(), fromWalletId:uuid("from_wallet_id").notNull().references(()=>wallets.id), toWalletId:uuid("to_wallet_id").notNull().references(()=>wallets.id), signature:text("signature").notNull(), lamports:numeric("lamports",{precision:30,scale:0}).notNull(), slot:bigint("slot",{mode:"bigint"}).notNull(), blockTime:timestamp("block_time",{withTimezone:true}).notNull(), hop:integer("hop").notNull().default(1), confidence:numeric("confidence",{precision:5,scale:4}).notNull().default("1"), createdAt:timestamp("created_at",{withTimezone:true}).defaultNow().notNull() },table=>[uniqueIndex("funding_signature_to_unique").on(table.signature,table.toWalletId),index("funding_from_idx").on(table.fromWalletId),index("funding_to_idx").on(table.toWalletId)]);
export const holderSnapshots = pgTable("holder_snapshots", { id:uuid("id").defaultRandom().primaryKey(), tokenId:uuid("token_id").notNull().references(()=>tokens.id), slot:bigint("slot",{mode:"bigint"}).notNull(), supplyRaw:numeric("supply_raw",{precision:78,scale:0}).notNull(), creatorClusterPct:numeric("creator_cluster_pct",{precision:8,scale:4}), capturedAt:timestamp("captured_at",{withTimezone:true}).defaultNow().notNull() },table=>[index("holder_snapshot_token_time_idx").on(table.tokenId,table.capturedAt)]);
export const holderBalances = pgTable("holder_balances", { id:uuid("id").defaultRandom().primaryKey(), snapshotId:uuid("snapshot_id").notNull().references(()=>holderSnapshots.id), walletId:uuid("wallet_id").references(()=>wallets.id), tokenAccount:text("token_account").notNull(), rank:integer("rank").notNull(), amountRaw:numeric("amount_raw",{precision:78,scale:0}).notNull(), percentage:numeric("percentage",{precision:10,scale:4}).notNull(), excluded:boolean("excluded").notNull().default(false), exclusionReason:text("exclusion_reason") },table=>[uniqueIndex("holder_snapshot_account_unique").on(table.snapshotId,table.tokenAccount)]);

export const bundleAssessments = pgTable("bundle_assessments", { id:uuid("id").defaultRandom().primaryKey(), tokenId:uuid("token_id").notNull().references(()=>tokens.id), holderSnapshotId:uuid("holder_snapshot_id").notNull().references(()=>holderSnapshots.id), suspectedBundlePct:numeric("suspected_bundle_pct",{precision:8,scale:4}).notNull(), confidence:integer("confidence").notNull(), coveredTransactions:integer("covered_transactions").notNull(), truncated:boolean("truncated").notNull(), suspiciousWallets:jsonb("suspicious_wallets").$type<string[]>().notNull(), evidence:jsonb("evidence").$type<Array<Record<string,unknown>>>().notNull(), assessedAt:timestamp("assessed_at",{withTimezone:true}).defaultNow().notNull() },table=>[index("bundle_token_time_idx").on(table.tokenId,table.assessedAt)]);

export const pools = pgTable("pools", {
  id: uuid("id").defaultRandom().primaryKey(), tokenId: uuid("token_id").notNull().references(() => tokens.id), address: text("address").notNull(), dex: text("dex").notNull(), quoteMint: text("quote_mint").notNull(), liquidityUsd: numeric("liquidity_usd", { precision: 24, scale: 8 }), volume1hUsd: numeric("volume_1h_usd", { precision: 24, scale: 8 }), volume24hUsd: numeric("volume_24h_usd", { precision: 24, scale: 8 }), priceChange1h: numeric("price_change_1h", { precision: 16, scale: 8 }), priceUsd: numeric("price_usd", { precision: 38, scale: 18 }), pairCreatedAt: timestamp("pair_created_at", { withTimezone: true }), verified: boolean("verified").notNull().default(false), ...timestamps,
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
  id: uuid("id").defaultRandom().primaryKey(), signalId: uuid("signal_id").references(() => signals.id), tokenId: uuid("token_id").notNull().references(() => tokens.id), mode: tradingMode("mode").notNull().default("paper"), side: orderSide("side").notNull(), status: orderStatus("status").notNull().default("created"), idempotencyKey: text("idempotency_key").notNull(), requestedAmountRaw: numeric("requested_amount_raw", { precision: 78, scale: 0 }).notNull(), quoteRaw: jsonb("quote_raw").$type<Record<string, unknown>>(), signature: text("signature"), error: text("error"),
  // Live recovery: the signing wallet and blockhash expiry are persisted before a transaction is sent.
  wallet: text("wallet"), lastValidBlockHeight: bigint("last_valid_block_height", { mode: "bigint" }), sentAt: timestamp("sent_at", { withTimezone: true }),
  // "manual" orders are signed and sent by the user's browser wallet; "auto" orders by the bot's hot wallet.
  origin: text("origin").notNull().default("auto"), ...timestamps,
}, (table) => [uniqueIndex("orders_idempotency_unique").on(table.idempotencyKey), uniqueIndex("orders_signature_unique").on(table.signature), index("orders_status_created_idx").on(table.status, table.createdAt)]);

export const fills = pgTable("fills", {
  id: uuid("id").defaultRandom().primaryKey(), orderId: uuid("order_id").notNull().references(() => orders.id), signature: text("signature").notNull(), baseAmountRaw: numeric("base_amount_raw", { precision: 78, scale: 0 }).notNull(), quoteAmountRaw: numeric("quote_amount_raw", { precision: 78, scale: 0 }).notNull(), feeLamports: numeric("fee_lamports", { precision: 30, scale: 0 }).notNull().default("0"), slot: bigint("slot", { mode: "bigint" }), filledAt: timestamp("filled_at", { withTimezone: true }).notNull(),
}, (table) => [uniqueIndex("fills_signature_order_unique").on(table.signature, table.orderId), index("fills_order_idx").on(table.orderId)]);

export const positions = pgTable("positions", {
  id: uuid("id").defaultRandom().primaryKey(), tokenId: uuid("token_id").notNull().references(() => tokens.id), mode: tradingMode("mode").notNull(), status: positionStatus("status").notNull().default("open"), quantityRaw: numeric("quantity_raw", { precision: 78, scale: 0 }).notNull(), costLamports: numeric("cost_lamports", { precision: 30, scale: 0 }).notNull(), realizedPnlLamports: numeric("realized_pnl_lamports", { precision: 30, scale: 0 }).notNull().default("0"),
  // "manual" positions come from trigger orders and are exited only by the user's own triggers, never by automated exit rules.
  origin: text("origin").notNull().default("auto"), wallet: text("wallet"), openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(), closedAt: timestamp("closed_at", { withTimezone: true }), ...timestamps,
}, (table) => [index("positions_token_status_idx").on(table.tokenId, table.status), index("positions_mode_status_idx").on(table.mode, table.status)]);

export const positionMarks = pgTable("position_marks", {
  id: uuid("id").defaultRandom().primaryKey(), positionId: uuid("position_id").notNull().references(() => positions.id), valueLamports: numeric("value_lamports", { precision: 30, scale: 0 }).notNull(), unrealizedPnlLamports: numeric("unrealized_pnl_lamports", { precision: 30, scale: 0 }).notNull(), pnlBps: integer("pnl_bps").notNull(), quoteRaw: jsonb("quote_raw").$type<Record<string, unknown>>().notNull(), markedAt: timestamp("marked_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("position_marks_position_time_idx").on(table.positionId, table.markedAt)]);

export const triggerOrders = pgTable("trigger_orders", {
  id: uuid("id").defaultRandom().primaryKey(), tokenId: uuid("token_id").notNull().references(() => tokens.id), positionId: uuid("position_id").references(() => positions.id), mode: tradingMode("mode").notNull().default("shadow"),
  type: triggerType("type").notNull(), status: triggerStatus("status").notNull().default("active"),
  triggerMcapUsd: numeric("trigger_mcap_usd", { precision: 30, scale: 2 }), trailingBps: integer("trailing_bps"), peakMcapUsd: numeric("peak_mcap_usd", { precision: 30, scale: 2 }),
  buyLamports: numeric("buy_lamports", { precision: 30, scale: 0 }), sellPctBps: integer("sell_pct_bps"), maxSlippageBps: integer("max_slippage_bps").notNull().default(300),
  ocoGroup: uuid("oco_group"), expiresAt: timestamp("expires_at", { withTimezone: true }), lastMcapUsd: numeric("last_mcap_usd", { precision: 30, scale: 2 }), lastError: text("last_error"),
  resultOrderId: uuid("result_order_id").references(() => orders.id), triggeredAt: timestamp("triggered_at", { withTimezone: true }), filledAt: timestamp("filled_at", { withTimezone: true }), ...timestamps,
}, (table) => [index("trigger_orders_status_idx").on(table.status), index("trigger_orders_token_idx").on(table.tokenId), index("trigger_orders_oco_idx").on(table.ocoGroup)]);

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(), eventType: text("event_type").notNull(), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(), payload: jsonb("payload").$type<Record<string, unknown>>().notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("audit_entity_idx").on(table.entityType, table.entityId, table.createdAt)]);
