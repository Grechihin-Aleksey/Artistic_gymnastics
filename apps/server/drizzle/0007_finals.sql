CREATE TYPE "public"."stage" AS ENUM('QUAL', 'FINAL');--> statement-breakpoint
CREATE TABLE "finalists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competition_id" uuid NOT NULL,
	"apparatus" "apparatus" NOT NULL,
	"category_id" uuid,
	"gymnast_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"reserve" boolean DEFAULT false NOT NULL,
	"qual_rank" integer NOT NULL,
	"qual_total" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "performances_unique";--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "phase" "stage" DEFAULT 'QUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "final_size" integer DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "final_reserves" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "final_per_club" integer;--> statement-breakpoint
ALTER TABLE "performances" ADD COLUMN "stage" "stage" DEFAULT 'QUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "finalists" ADD CONSTRAINT "finalists_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finalists" ADD CONSTRAINT "finalists_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finalists" ADD CONSTRAINT "finalists_gymnast_id_gymnasts_id_fk" FOREIGN KEY ("gymnast_id") REFERENCES "public"."gymnasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finalists_unique" ON "finalists" USING btree ("competition_id","apparatus","gymnast_id");--> statement-breakpoint
CREATE UNIQUE INDEX "performances_unique" ON "performances" USING btree ("gymnast_id","apparatus","stage","attempt");