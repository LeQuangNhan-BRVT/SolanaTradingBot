ALTER TABLE "pools" ADD COLUMN "volume_1h_usd" numeric(24, 8);--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "volume_24h_usd" numeric(24, 8);--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "price_change_1h" numeric(16, 8);--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "pair_created_at" timestamp with time zone;