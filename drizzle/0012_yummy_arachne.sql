CREATE TABLE "discovered_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mint" text NOT NULL,
	"pool_address" text NOT NULL,
	"migration_signature" text NOT NULL,
	"slot" bigint NOT NULL,
	"migrated_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"symbol" text,
	"name" text,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evaluation" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"market_checked_at" timestamp with time zone,
	"top10_checked_at" timestamp with time zone,
	"bundle_checked_at" timestamp with time zone,
	"fees_checked_at" timestamp with time zone,
	"flags_checked_at" timestamp with time zone,
	"matched_preset_id" uuid,
	"promoted_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "filter_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"rules" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"auto_promote" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovered_tokens" ADD CONSTRAINT "discovered_tokens_matched_preset_id_filter_presets_id_fk" FOREIGN KEY ("matched_preset_id") REFERENCES "public"."filter_presets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_tokens_mint_unique" ON "discovered_tokens" USING btree ("mint");--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_tokens_signature_unique" ON "discovered_tokens" USING btree ("migration_signature");--> statement-breakpoint
CREATE INDEX "discovered_tokens_status_idx" ON "discovered_tokens" USING btree ("status","migrated_at");