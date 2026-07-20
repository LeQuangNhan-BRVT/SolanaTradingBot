CREATE TABLE "holder_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"wallet_id" uuid,
	"token_account" text NOT NULL,
	"rank" integer NOT NULL,
	"amount_raw" numeric(78, 0) NOT NULL,
	"percentage" numeric(10, 4) NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"exclusion_reason" text
);
--> statement-breakpoint
CREATE TABLE "holder_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"slot" bigint NOT NULL,
	"supply_raw" numeric(78, 0) NOT NULL,
	"creator_cluster_pct" numeric(8, 4) NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_funding_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_wallet_id" uuid NOT NULL,
	"to_wallet_id" uuid NOT NULL,
	"signature" text NOT NULL,
	"lamports" numeric(30, 0) NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"hop" integer DEFAULT 1 NOT NULL,
	"confidence" numeric(5, 4) DEFAULT '1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "holder_balances" ADD CONSTRAINT "holder_balances_snapshot_id_holder_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."holder_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holder_balances" ADD CONSTRAINT "holder_balances_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holder_snapshots" ADD CONSTRAINT "holder_snapshots_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_edges" ADD CONSTRAINT "wallet_funding_edges_from_wallet_id_wallets_id_fk" FOREIGN KEY ("from_wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_edges" ADD CONSTRAINT "wallet_funding_edges_to_wallet_id_wallets_id_fk" FOREIGN KEY ("to_wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "holder_snapshot_account_unique" ON "holder_balances" USING btree ("snapshot_id","token_account");--> statement-breakpoint
CREATE INDEX "holder_snapshot_token_time_idx" ON "holder_snapshots" USING btree ("token_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "funding_signature_to_unique" ON "wallet_funding_edges" USING btree ("signature","to_wallet_id");--> statement-breakpoint
CREATE INDEX "funding_from_idx" ON "wallet_funding_edges" USING btree ("from_wallet_id");--> statement-breakpoint
CREATE INDEX "funding_to_idx" ON "wallet_funding_edges" USING btree ("to_wallet_id");