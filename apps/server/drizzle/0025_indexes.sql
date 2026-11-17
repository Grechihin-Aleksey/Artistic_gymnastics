CREATE INDEX "audit_log_competition_idx" ON "audit_log" USING btree ("competition_id","created_at");--> statement-breakpoint
CREATE INDEX "inquiries_competition_idx" ON "inquiries" USING btree ("competition_id","created_at");--> statement-breakpoint
CREATE INDEX "inquiries_performance_idx" ON "inquiries" USING btree ("performance_id");--> statement-breakpoint
CREATE INDEX "marks_judge_idx" ON "marks" USING btree ("judge_id");--> statement-breakpoint
CREATE INDEX "online_entries_competition_idx" ON "online_entries" USING btree ("competition_id");--> statement-breakpoint
CREATE INDEX "performances_competition_idx" ON "performances" USING btree ("competition_id","apparatus","status");--> statement-breakpoint
CREATE INDEX "teams_competition_idx" ON "teams" USING btree ("competition_id");