CREATE TYPE "public"."apparatus" AS ENUM('FX', 'PH', 'SR', 'VT', 'PB', 'HB', 'UB', 'BB');--> statement-breakpoint
CREATE TYPE "public"."discipline" AS ENUM('MAG', 'WAG');--> statement-breakpoint
CREATE TYPE "public"."judge_role" AS ENUM('D', 'E', 'SUPERVISOR');--> statement-breakpoint
CREATE TYPE "public"."mark_kind" AS ENUM('D', 'E', 'NEUTRAL');--> statement-breakpoint
CREATE TYPE "public"."performance_status" AS ENUM('SCORING', 'APPROVED');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competition_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"discipline" "discipline" NOT NULL,
	"team_roster" integer DEFAULT 5 NOT NULL,
	"team_per_apparatus" integer DEFAULT 4 NOT NULL,
	"team_counting" integer DEFAULT 3 NOT NULL,
	"publish_judge_marks" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gymnasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competition_id" uuid NOT NULL,
	"team_id" uuid,
	"bib" integer NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"club" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "judges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competition_id" uuid NOT NULL,
	"name" text NOT NULL,
	"apparatus" "apparatus" NOT NULL,
	"role" "judge_role" NOT NULL,
	"seat" integer NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "judges_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "marks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"performance_id" uuid NOT NULL,
	"judge_id" uuid NOT NULL,
	"kind" "mark_kind" NOT NULL,
	"value" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competition_id" uuid NOT NULL,
	"gymnast_id" uuid NOT NULL,
	"apparatus" "apparatus" NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" "performance_status" DEFAULT 'SCORING' NOT NULL,
	"d" integer,
	"e" integer,
	"neutral" integer,
	"total" integer,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competition_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gymnasts" ADD CONSTRAINT "gymnasts_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gymnasts" ADD CONSTRAINT "gymnasts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judges" ADD CONSTRAINT "judges_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_performance_id_performances_id_fk" FOREIGN KEY ("performance_id") REFERENCES "public"."performances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_judge_id_judges_id_fk" FOREIGN KEY ("judge_id") REFERENCES "public"."judges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performances" ADD CONSTRAINT "performances_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performances" ADD CONSTRAINT "performances_gymnast_id_gymnasts_id_fk" FOREIGN KEY ("gymnast_id") REFERENCES "public"."gymnasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gymnasts_bib_unique" ON "gymnasts" USING btree ("competition_id","bib");--> statement-breakpoint
CREATE UNIQUE INDEX "judges_seat_unique" ON "judges" USING btree ("competition_id","apparatus","role","seat");--> statement-breakpoint
CREATE UNIQUE INDEX "marks_judge_unique" ON "marks" USING btree ("performance_id","judge_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "performances_unique" ON "performances" USING btree ("gymnast_id","apparatus","attempt");