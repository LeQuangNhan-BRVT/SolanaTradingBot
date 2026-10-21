CREATE TABLE "position_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" uuid NOT NULL,
	"value_lamports" numeric(30, 0) NOT NULL,
	"unrealized_pnl_lamports" numeric(30, 0) NOT NULL,
	"pnl_bps" integer NOT NULL,
	"quote_raw" jsonb NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "position_marks" ADD CONSTRAINT "position_marks_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "position_marks_position_time_idx" ON "position_marks" USING btree ("position_id","marked_at");