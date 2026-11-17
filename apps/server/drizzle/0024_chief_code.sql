ALTER TABLE "competitions" ADD COLUMN "chief_token_hash" text;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "chief_token_sealed" text;--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_chief_token_hash_unique" UNIQUE("chief_token_hash");