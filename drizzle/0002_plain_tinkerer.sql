CREATE TABLE "token_creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"creator_wallet_id" uuid NOT NULL,
	"user_wallet_id" uuid NOT NULL,
	"fee_payer_wallet_id" uuid NOT NULL,
	"signature" text NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"instruction" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "token_creators" ADD CONSTRAINT "token_creators_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_creators" ADD CONSTRAINT "token_creators_creator_wallet_id_wallets_id_fk" FOREIGN KEY ("creator_wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_creators" ADD CONSTRAINT "token_creators_user_wallet_id_wallets_id_fk" FOREIGN KEY ("user_wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_creators" ADD CONSTRAINT "token_creators_fee_payer_wallet_id_wallets_id_fk" FOREIGN KEY ("fee_payer_wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "token_creators_token_unique" ON "token_creators" USING btree ("token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "token_creators_signature_unique" ON "token_creators" USING btree ("signature");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_address_unique" ON "wallets" USING btree ("address");