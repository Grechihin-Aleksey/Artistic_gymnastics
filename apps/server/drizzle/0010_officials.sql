ALTER TABLE "competitions" ADD COLUMN "officials" jsonb DEFAULT '{"chiefJudge":null,"chiefSecretary":null}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "judges" ADD COLUMN "category" text;