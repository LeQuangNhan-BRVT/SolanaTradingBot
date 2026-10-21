CREATE TABLE "tracked_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "price_usd" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "watch_note" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "watch_tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "auto_trade" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "alert_price_above_usd" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "alert_price_below_usd" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "alert_change_1h_pct" numeric(10, 4);--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_wallets_address_unique" ON "tracked_wallets" USING btree ("address");