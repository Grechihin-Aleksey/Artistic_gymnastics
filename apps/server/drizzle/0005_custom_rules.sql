CREATE TYPE "public"."rules" AS ENUM('FIG', 'CUSTOM');--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "base" integer;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "apparatus_base" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "rules" "rules" DEFAULT 'FIG' NOT NULL;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "deductions" jsonb DEFAULT '[]'::jsonb NOT NULL;