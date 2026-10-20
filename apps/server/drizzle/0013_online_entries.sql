CREATE TYPE "public"."online_entry_status" AS ENUM('NEW', 'ACCEPTED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "online_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"competition_id" uuid NOT NULL,
	"entry" jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"status" "online_entry_status" DEFAULT 'NEW' NOT NULL,
	"note" text,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "entry_key" text;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "entries_open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "entries_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "entries_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "online_entries" ADD CONSTRAINT "online_entries_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;