CREATE TYPE "public"."trigger_status" AS ENUM('active', 'triggered', 'filled', 'cancelled', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."trigger_type" AS ENUM('limit_buy', 'take_profit', 'stop_loss', 'trailing_stop');--> statement-breakpoint
CREATE TABLE "trigger_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"position_id" uuid,
	"mode" "trading_mode" DEFAULT 'shadow' NOT NULL,
	"type" "trigger_type" NOT NULL,
	"status" "trigger_status" DEFAULT 'active' NOT NULL,
	"trigger_mcap_usd" numeric(30, 2),
	"trailing_bps" integer,
	"peak_mcap_usd" numeric(30, 2),
	"buy_lamports" numeric(30, 0),
	"sell_pct_bps" integer,
	"max_slippage_bps" integer DEFAULT 300 NOT NULL,
	"oco_group" uuid,
	"expires_at" timestamp with time zone,
	"last_mcap_usd" numeric(30, 2),
	"last_error" text,
	"result_order_id" uuid,
	"triggered_at" timestamp with time zone,
	"filled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "origin" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "trigger_orders" ADD CONSTRAINT "trigger_orders_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_orders" ADD CONSTRAINT "trigger_orders_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_orders" ADD CONSTRAINT "trigger_orders_result_order_id_orders_id_fk" FOREIGN KEY ("result_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trigger_orders_status_idx" ON "trigger_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "trigger_orders_token_idx" ON "trigger_orders" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "trigger_orders_oco_idx" ON "trigger_orders" USING btree ("oco_group");