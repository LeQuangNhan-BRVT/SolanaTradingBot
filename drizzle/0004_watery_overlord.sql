CREATE TABLE "bundle_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"holder_snapshot_id" uuid NOT NULL,
	"suspected_bundle_pct" numeric(8, 4) NOT NULL,
	"confidence" integer NOT NULL,
	"covered_transactions" integer NOT NULL,
	"truncated" boolean NOT NULL,
	"suspicious_wallets" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bundle_assessments" ADD CONSTRAINT "bundle_assessments_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundle_assessments" ADD CONSTRAINT "bundle_assessments_holder_snapshot_id_holder_snapshots_id_fk" FOREIGN KEY ("holder_snapshot_id") REFERENCES "public"."holder_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bundle_token_time_idx" ON "bundle_assessments" USING btree ("token_id","assessed_at");