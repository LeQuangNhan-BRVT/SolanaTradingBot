CREATE TYPE "public"."candidate_status" AS ENUM('monitoring', 'eligible', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."order_side" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('created', 'quoted', 'simulated', 'submitted', 'confirmed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."position_status" AS ENUM('open', 'closing', 'closed');--> statement-breakpoint
CREATE TYPE "public"."trading_mode" AS ENUM('paper', 'shadow', 'live');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"signature" text NOT NULL,
	"base_amount_raw" numeric(78, 0) NOT NULL,
	"quote_amount_raw" numeric(78, 0) NOT NULL,
	"fee_lamports" numeric(30, 0) DEFAULT '0' NOT NULL,
	"slot" bigint,
	"filled_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"pool_id" uuid,
	"signature" text NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid,
	"token_id" uuid NOT NULL,
	"mode" "trading_mode" DEFAULT 'paper' NOT NULL,
	"side" "order_side" NOT NULL,
	"status" "order_status" DEFAULT 'created' NOT NULL,
	"idempotency_key" text NOT NULL,
	"requested_amount_raw" numeric(78, 0) NOT NULL,
	"quote_raw" jsonb,
	"signature" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"address" text NOT NULL,
	"dex" text NOT NULL,
	"quote_mint" text NOT NULL,
	"liquidity_usd" numeric(24, 8),
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"mode" "trading_mode" NOT NULL,
	"status" "position_status" DEFAULT 'open' NOT NULL,
	"quantity_raw" numeric(78, 0) NOT NULL,
	"cost_lamports" numeric(30, 0) NOT NULL,
	"realized_pnl_lamports" numeric(30, 0) DEFAULT '0' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "candidate_status" NOT NULL,
	"score" integer NOT NULL,
	"creator_cluster_pct" numeric(8, 4),
	"suspected_bundle_pct" numeric(8, 4),
	"checks" jsonb NOT NULL,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"risk_assessment_id" uuid NOT NULL,
	"strategy_version" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"score" numeric(12, 6) NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mint" text NOT NULL,
	"symbol" text DEFAULT '—' NOT NULL,
	"name" text DEFAULT 'Token chưa nhận diện' NOT NULL,
	"launchpad" text DEFAULT 'Unknown' NOT NULL,
	"token_program" text,
	"decimals" integer,
	"supply_raw" numeric(78, 0),
	"mint_authority" text,
	"freeze_authority" text,
	"status" "candidate_status" DEFAULT 'monitoring' NOT NULL,
	"risk_score" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_events" ADD CONSTRAINT "migration_events_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_events" ADD CONSTRAINT "migration_events_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pools" ADD CONSTRAINT "pools_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_risk_assessment_id_risk_assessments_id_fk" FOREIGN KEY ("risk_assessment_id") REFERENCES "public"."risk_assessments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fills_signature_order_unique" ON "fills" USING btree ("signature","order_id");--> statement-breakpoint
CREATE INDEX "fills_order_idx" ON "fills" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_signature_unique" ON "migration_events" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "migration_token_time_idx" ON "migration_events" USING btree ("token_id","block_time");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idempotency_unique" ON "orders" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_signature_unique" ON "orders" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "orders_status_created_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pools_address_unique" ON "pools" USING btree ("address");--> statement-breakpoint
CREATE INDEX "pools_token_idx" ON "pools" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "positions_token_status_idx" ON "positions" USING btree ("token_id","status");--> statement-breakpoint
CREATE INDEX "positions_mode_status_idx" ON "positions" USING btree ("mode","status");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_token_version_unique" ON "risk_assessments" USING btree ("token_id","version");--> statement-breakpoint
CREATE INDEX "risk_token_assessed_idx" ON "risk_assessments" USING btree ("token_id","assessed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "signals_idempotency_unique" ON "signals" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "signals_token_created_idx" ON "signals" USING btree ("token_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tokens_mint_unique" ON "tokens" USING btree ("mint");--> statement-breakpoint
CREATE INDEX "tokens_status_idx" ON "tokens" USING btree ("status");