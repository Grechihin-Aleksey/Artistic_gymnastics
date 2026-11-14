CREATE TYPE "public"."vault_rule" AS ENUM('FIG', 'BEST');--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "vault_rule" "vault_rule" DEFAULT 'FIG' NOT NULL;