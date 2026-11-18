ALTER TYPE "public"."vault_rule" ADD VALUE 'CATEGORY';--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "vault_mode" text;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "team_event" boolean DEFAULT true NOT NULL;