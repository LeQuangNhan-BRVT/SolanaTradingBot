ALTER TABLE "orders" ADD COLUMN "wallet" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "last_valid_block_height" bigint;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "sent_at" timestamp with time zone;