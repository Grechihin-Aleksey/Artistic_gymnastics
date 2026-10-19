import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { APPARATUS, DISCIPLINES, JUDGE_ROLES, MARK_KINDS, PERFORMANCE_STATUSES } from "@ag/shared";

export const disciplineEnum = pgEnum("discipline", DISCIPLINES);
export const apparatusEnum = pgEnum("apparatus", APPARATUS);
export const judgeRoleEnum = pgEnum("judge_role", JUDGE_ROLES);
export const markKindEnum = pgEnum("mark_kind", MARK_KINDS);
export const performanceStatusEnum = pgEnum("performance_status", PERFORMANCE_STATUSES);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const competitions = pgTable("competitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  discipline: disciplineEnum("discipline").notNull(),
  teamRoster: integer("team_roster").notNull().default(5),
  teamPerApparatus: integer("team_per_apparatus").notNull().default(4),
  teamCounting: integer("team_counting").notNull().default(3),
  publishJudgeMarks: boolean("publish_judge_marks").notNull().default(false),
  createdAt: createdAt(),
});

export const teams = pgTable("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  competitionId: uuid("competition_id")
    .notNull()
    .references(() => competitions.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const gymnasts = pgTable(
  "gymnasts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    competitionId: uuid("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    bib: integer("bib").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    club: text("club"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("gymnasts_bib_unique").on(t.competitionId, t.bib)],
);

export const judges = pgTable(
  "judges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    competitionId: uuid("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    apparatus: apparatusEnum("apparatus").notNull(),
    role: judgeRoleEnum("role").notNull(),
    seat: integer("seat").notNull(),
    /** SHA-256 токена входа; сам токен показывается один раз при создании. */
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("judges_seat_unique").on(t.competitionId, t.apparatus, t.role, t.seat)],
);

/** Все оценки хранятся в тысячных долях балла. */
export const performances = pgTable(
  "performances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    competitionId: uuid("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    gymnastId: uuid("gymnast_id")
      .notNull()
      .references(() => gymnasts.id, { onDelete: "cascade" }),
    apparatus: apparatusEnum("apparatus").notNull(),
    attempt: integer("attempt").notNull().default(1),
    status: performanceStatusEnum("status").notNull().default("SCORING"),
    d: integer("d"),
    e: integer("e"),
    neutral: integer("neutral"),
    total: integer("total"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("performances_unique").on(t.gymnastId, t.apparatus, t.attempt)],
);

export const marks = pgTable(
  "marks",
  {
    /** Идентификатор с планшета судьи: повторная отправка того же id не создаёт дубль. */
    id: uuid("id").primaryKey(),
    performanceId: uuid("performance_id")
      .notNull()
      .references(() => performances.id, { onDelete: "cascade" }),
    judgeId: uuid("judge_id")
      .notNull()
      .references(() => judges.id, { onDelete: "cascade" }),
    kind: markKindEnum("kind").notNull(),
    value: integer("value").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("marks_judge_unique").on(t.performanceId, t.judgeId, t.kind)],
);

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  competitionId: uuid("competition_id")
    .notNull()
    .references(() => competitions.id, { onDelete: "cascade" }),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  details: jsonb("details").notNull(),
  createdAt: createdAt(),
});
