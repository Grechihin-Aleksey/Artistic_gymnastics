ALTER TABLE "competitions" ADD COLUMN "e_tolerance" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "e_tolerance_table" jsonb;