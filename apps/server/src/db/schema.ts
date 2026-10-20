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
import { APPARATUS, DISCIPLINES, INQUIRY_STATUSES, GYMNAST_STATUSES, JUDGE_ROLES, MARK_KINDS, PERFORMANCE_STATUSES, RULES, STAGES } from "@ag/shared";

export const disciplineEnum = pgEnum("discipline", DISCIPLINES);
export const apparatusEnum = pgEnum("apparatus", APPARATUS);
export const judgeRoleEnum = pgEnum("judge_role", JUDGE_ROLES);
export const markKindEnum = pgEnum("mark_kind", MARK_KINDS);
export const performanceStatusEnum = pgEnum("performance_status", PERFORMANCE_STATUSES);
export const inquiryStatusEnum = pgEnum("inquiry_status", INQUIRY_STATUSES);
export const rulesEnum = pgEnum("rules", RULES);
export const gymnastStatusEnum = pgEnum("gymnast_status", GYMNAST_STATUSES);
export const stageEnum = pgEnum("stage", STAGES);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const competitions = pgTable("competitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  discipline: disciplineEnum("discipline").notNull(),
  teamRoster: integer("team_roster").notNull().default(5),
  teamPerApparatus: integer("team_per_apparatus").notNull().default(4),
  teamCounting: integer("team_counting").notNull().default(3),
  publishJudgeMarks: boolean("publish_judge_marks").notNull().default(false),
  /** Номер текущей ротации с нуля: смена s сейчас на снаряде (старт + rotation) по олимпийскому порядку. */
  rotation: integer("rotation").notNull().default(0),
  /** Логотип для шапки протоколов: data URL картинки PNG или JPEG. */
  logo: text("logo"),
  /** FIG или свои правила: база по разряду минус сбавки. */
  rules: rulesEnum("rules").notNull().default("FIG"),
  /** Своих правил: список сбавок за требования, баллы в тысячных. */
  deductions: jsonb("deductions").$type<{ name: string; value: number }[]>().notNull().default([]),
  /** Идёт квалификация или финалы на снарядах: новые выступления получают этот этап. */
  phase: stageEnum("phase").notNull().default("QUAL"),
  /** Параметры отбора в финалы, с которыми их сформировали последний раз. */
  finalSize: integer("final_size").notNull().default(8),
  finalReserves: integer("final_reserves").notNull().default(2),
  finalPerClub: integer("final_per_club"),
  createdAt: createdAt(),
});

/** Разряд или возрастная группа: у каждого свои места, многоборье и команды. */
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    competitionId: uuid("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    /** Своих правил: базовая оценка разряда в тысячных и её замены на отдельных снарядах. */
    base: integer("base"),
    apparatusBase: jsonb("apparatus_base").$type<Partial<Record<(typeof APPARATUS)[number], number>>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("categories_name_unique").on(t.competitionId, t.name)],
);

/** Смена переходит со снаряда на снаряд по кругу, начиная со стартового. */
export const shifts = pgTable(
  "shifts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    competitionId: uuid("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    startApparatus: apparatusEnum("start_apparatus").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("shifts_number_unique").on(t.competitionId, t.number)],
);

export const teams = pgTable("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  competitionId: uuid("competition_id")
    .notNull()
    .references(() => competitions.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Команда выступает в зачёте своего разряда. */
  categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
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
    /** Отчество, дата рождения (ГГГГ или ДД.ММ.ГГГГ), город или регион, тренер. */
    middleName: text("middle_name"),
    birthDate: text("birth_date"),
    city: text("city"),
    coach: text("coach"),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    /** Номер смены и порядок выхода в ней (порядок строк в загруженном списке). */
    shift: integer("shift"),
    startOrder: integer("start_order"),
    /** Не явился или снялся: не вызывается на снаряды и не попадает в многоборье. */
    status: gymnastStatusEnum("status").notNull().default("ACTIVE"),
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
    /**
     * Один планшет на снаряд: старший судья вводит оценки всей бригады сам.
     * Судьи D и E всё равно заводятся — их фамилии и оценки идут в протокол.
     */
    enterAllMarks: boolean("enter_all_marks").notNull().default(false),
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
    stage: stageEnum("stage").notNull().default("QUAL"),
    status: performanceStatusEnum("status").notNull().default("SCORING"),
    d: integer("d"),
    e: integer("e"),
    neutral: integer("neutral"),
    total: integer("total"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("performances_unique").on(t.gymnastId, t.apparatus, t.stage, t.attempt)],
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

/** Финалисты на снаряде в разряде: порядок выступления по жеребьёвке и запасные. */
export const finalists = pgTable(
  "finalists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    competitionId: uuid("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    apparatus: apparatusEnum("apparatus").notNull(),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "cascade" }),
    gymnastId: uuid("gymnast_id")
      .notNull()
      .references(() => gymnasts.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    reserve: boolean("reserve").notNull().default(false),
    qualRank: integer("qual_rank").notNull(),
    qualTotal: integer("qual_total").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("finalists_unique").on(t.competitionId, t.apparatus, t.gymnastId)],
);

/** Запросы тренеров на пересмотр оценки D. Баллы в тысячных. */
export const inquiries = pgTable("inquiries", {
  id: uuid("id").primaryKey().defaultRandom(),
  competitionId: uuid("competition_id")
    .notNull()
    .references(() => competitions.id, { onDelete: "cascade" }),
  performanceId: uuid("performance_id")
    .notNull()
    .references(() => performances.id, { onDelete: "cascade" }),
  coach: text("coach").notNull(),
  claimedD: integer("claimed_d"),
  previousD: integer("previous_d").notNull(),
  newD: integer("new_d"),
  status: inquiryStatusEnum("status").notNull().default("PENDING"),
  late: boolean("late").notNull(),
  note: text("note"),
  createdAt: createdAt(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

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
