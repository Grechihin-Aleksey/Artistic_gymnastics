CREATE TYPE "public"."gymnast_status" AS ENUM('ACTIVE', 'DNS', 'WITHDRAWN');--> statement-breakpoint
ALTER TABLE "gymnasts" ADD COLUMN "status" "gymnast_status" DEFAULT 'ACTIVE' NOT NULL;