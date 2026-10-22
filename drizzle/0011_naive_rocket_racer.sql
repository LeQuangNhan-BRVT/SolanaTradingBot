ALTER TABLE "orders" ADD COLUMN "origin" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "wallet" text;