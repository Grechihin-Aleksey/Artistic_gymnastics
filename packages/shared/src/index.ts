import { z } from "zod";

export const DISCIPLINES = ["MAG", "WAG"] as const;
export const APPARATUS = ["FX", "PH", "SR", "VT", "PB", "HB", "UB", "BB"] as const;
export const JUDGE_ROLES = ["D", "E", "SUPERVISOR"] as const;
export const MARK_KINDS = ["D", "E", "NEUTRAL"] as const;
export const PERFORMANCE_STATUSES = ["SCORING", "APPROVED"] as const;
export const INQUIRY_STATUSES = ["PENDING", "ACCEPTED", "REJECTED"] as const;

export const disciplineSchema = z.enum(DISCIPLINES);
export const apparatusSchema = z.enum(APPARATUS);
export const judgeRoleSchema = z.enum(JUDGE_ROLES);
export const markKindSchema = z.enum(MARK_KINDS);

export type JudgeRole = z.infer<typeof judgeRoleSchema>;
export type MarkKind = z.infer<typeof markKindSchema>;
export type PerformanceStatus = (typeof PERFORMANCE_STATUSES)[number];

/** Балл с точностью до тысячных, передаётся числом: 8.7, 13.466. */
const score = z.number().min(0).max(20).multipleOf(0.001);

export const createCompetitionSchema = z.object({
  name: z.string().min(1).max(200),
  discipline: disciplineSchema,
  teamFormat: z
    .object({
      roster: z.number().int().min(1).max(10),
      perApparatus: z.number().int().min(1).max(10),
      counting: z.number().int().min(1).max(10),
    })
    .optional(),
  /** Публиковать ли на сайте сбавки каждого судьи E. */
  publishJudgeMarks: z.boolean().default(false),
});

export const createTeamSchema = z.object({
  name: z.string().min(1).max(200),
});

export const createGymnastSchema = z.object({
  bib: z.number().int().min(1),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  club: z.string().max(200).optional(),
  teamId: z.uuid().optional(),
});

export const createJudgeSchema = z.object({
  name: z.string().min(1).max(200),
  apparatus: apparatusSchema,
  role: judgeRoleSchema,
  /** Номер места в бригаде: D1, D2, E1…E7. */
  seat: z.number().int().min(1).max(10),
  /** Только для старшего судьи: один планшет на снаряд, он вводит оценки всей бригады. */
  enterAllMarks: z.boolean().default(false),
});

export const createPerformanceSchema = z.object({
  gymnastId: z.uuid(),
  apparatus: apparatusSchema,
  /** Номер попытки опорного прыжка; на остальных снарядах всегда 1. */
  attempt: z.number().int().min(1).max(2).default(1),
});

export const submitMarkSchema = z.object({
  /** Идентификатор, созданный на планшете: повторная отправка не создаёт дубль. */
  id: z.uuid(),
  performanceId: z.uuid(),
  kind: markKindSchema,
  value: score,
});

/**
 * Оценки всей бригады, введённые на единственном планшете снаряда.
 * Сбавки E — по местам судей E1, E2, …
 */
export const tabletScoreSchema = z.object({
  d: score,
  e: z.array(score.max(10)).min(1).max(10),
  neutral: score.optional(),
});

export const reopenPerformanceSchema = z.object({
  reason: z.string().min(1).max(500),
});

/** Список участников, вставленный секретариатом из таблицы. Команды создаются по названию. */
export const importGymnastsSchema = z.object({
  rows: z
    .array(
      z.object({
        bib: z.number().int().min(1),
        lastName: z.string().min(1).max(100),
        firstName: z.string().min(1).max(100),
        club: z.string().max(200).optional(),
        team: z.string().max(200).optional(),
        /** Разряд или возрастная группа; команды считаются внутри разряда. */
        category: z.string().max(100).optional(),
        /** Номер смены; порядок выхода в смене — порядок строк. */
        shift: z.number().int().min(1).max(50).optional(),
      }),
    )
    .min(1)
    .max(1000),
});

export const setShiftStartSchema = z.object({ startApparatus: apparatusSchema });

export const setRotationSchema = z.object({ rotation: z.number().int().min(0).max(20) });

/** Запрос тренера на пересмотр оценки D (FIG, Технический регламент, ст. 8.5). */
export const createInquirySchema = z.object({
  /** Кто подал: тренер, команда. */
  coach: z.string().min(1).max(200),
  /** Какую оценку D тренер считает верной, если указал. */
  claimedD: score.optional(),
});

/** Решение апелляционного жюри: оставить оценку или поставить новую D. */
export const resolveInquirySchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("accept"), d: score, note: z.string().max(500).optional() }),
  z.object({ decision: z.literal("reject"), note: z.string().max(500).optional() }),
]);

export type CreateCompetitionInput = z.infer<typeof createCompetitionSchema>;
export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type CreateGymnastInput = z.infer<typeof createGymnastSchema>;
export type CreateJudgeInput = z.infer<typeof createJudgeSchema>;
export type CreatePerformanceInput = z.infer<typeof createPerformanceSchema>;
export type SubmitMarkInput = z.infer<typeof submitMarkSchema>;
export type TabletScoreInput = z.infer<typeof tabletScoreSchema>;
export type ReopenPerformanceInput = z.infer<typeof reopenPerformanceSchema>;
export type ImportGymnastsInput = z.infer<typeof importGymnastsSchema>;
export type SetShiftStartInput = z.infer<typeof setShiftStartSchema>;
export type SetRotationInput = z.infer<typeof setRotationSchema>;
export type CreateInquiryInput = z.infer<typeof createInquirySchema>;
export type ResolveInquiryInput = z.infer<typeof resolveInquirySchema>;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

/** Оценка за выступление в баллах (не в тысячных). */
export interface ScoreView {
  d: number;
  e: number;
  neutral: number;
  total: number;
}

export interface MarkView {
  judgeId: string;
  seat: number;
  role: JudgeRole;
  kind: MarkKind;
  value: number;
}

export interface PerformanceView {
  id: string;
  competitionId: string;
  gymnastId: string;
  apparatus: (typeof APPARATUS)[number];
  attempt: number;
  status: PerformanceStatus;
  score: ScoreView | null;
  marks: MarkView[];
}

/** События Socket.IO. */
export const LIVE_EVENTS = {
  /** Клиент → сервер: подписаться на соревнование. */
  join: "competition.join",
  /** Сервер → бригада снаряда: пришла или изменилась оценка судьи. */
  marksUpdated: "performance.marks",
  /** Сервер → все: оценка утверждена. */
  approved: "performance.approved",
  /** Сервер → все: оценка возвращена на правку. */
  reopened: "performance.reopened",
  /** Сервер → все: вызван следующий участник. */
  called: "performance.called",
  /** Сервер → все: смены перешли на следующий снаряд или поменялся стартовый снаряд. */
  rotation: "competition.rotation",
} as const;

export function competitionRoom(competitionId: string): string {
  return `competition:${competitionId}`;
}

export function panelRoom(competitionId: string, apparatus: string): string {
  return `panel:${competitionId}:${apparatus}`;
}

export const APPARATUS_NAMES: Readonly<Record<string, string>> = {
  FX: "Вольные упражнения",
  PH: "Конь",
  SR: "Кольца",
  VT: "Опорный прыжок",
  PB: "Брусья",
  HB: "Перекладина",
  UB: "Брусья разной высоты",
  BB: "Бревно",
} satisfies Record<(typeof APPARATUS)[number], string>;

/** Ответы открытых эндпоинтов результатов: их читают табло и сайт. */
export interface GymnastView {
  id: string;
  bib: number;
  firstName: string;
  lastName: string;
  club: string | null;
  teamId: string | null;
  categoryId: string | null;
}

export interface ApparatusResultRow {
  rank: number;
  gymnast: GymnastView;
  score: ScoreView;
}

export interface AllAroundRow {
  rank: number;
  gymnast: GymnastView;
  total: number;
  complete: boolean;
  apparatus: Partial<Record<(typeof APPARATUS)[number], ScoreView>>;
}

export interface TeamResultRow {
  rank: number;
  team: { id: string; name: string | undefined };
  total: number;
  apparatus: { apparatus: (typeof APPARATUS)[number]; total: number; counted: string[] }[];
}

/** Что происходит на снаряде: кто выступает сейчас и последняя утверждённая оценка. */
export interface LiveApparatus {
  apparatus: (typeof APPARATUS)[number];
  current: { performanceId: string; attempt: number; gymnast: GymnastView } | null;
  last: {
    performanceId: string;
    attempt: number;
    gymnast: GymnastView;
    score: ScoreView;
    approvedAt: string;
    /** Сбавки судей E, если соревнование их публикует. */
    eMarks: number[] | null;
  } | null;
}

/**
 * Всё, что показывает табло, одним ответом. Его же сервер в зале отправляет
 * в облачный ретранслятор, а тот раздаёт сайту.
 */
export interface BoardSnapshot {
  competition: { id: string; name: string; discipline: (typeof DISCIPLINES)[number] };
  live: LiveApparatus[];
  /** Таблицы по разрядам. Если разрядов нет — одна запись с id null и пустым именем. */
  categories: CategoryResults[];
  /** Когда снимок собран на сервере в зале (ISO). */
  generatedAt: string;
}

export interface CategoryResults {
  id: string | null;
  name: string;
  allAround: AllAroundRow[];
  /** Пусто, если командного зачёта нет или состав команд не подходит под формат. */
  teams: TeamResultRow[];
  apparatus: Partial<Record<(typeof APPARATUS)[number], ApparatusResultRow[]>>;
}

/** Смены на снарядах в текущей ротации. */
export interface RotationView {
  /** Номер ротации с нуля. */
  rotation: number;
  /** Сколько ротаций в соревновании: по числу снарядов. */
  rotations: number;
  shifts: ShiftView[];
}

export interface ShiftView {
  number: number;
  startApparatus: (typeof APPARATUS)[number];
  /** Снаряд смены в текущей ротации. */
  apparatus: (typeof APPARATUS)[number];
  /** Участники в порядке выхода в этой ротации. */
  gymnastIds: string[];
}

/** Тело запроса POST /ingest/:competitionId на ретранслятор. */
export interface RelayIngest {
  snapshot: BoardSnapshot;
  /** Оценки, утверждённые с прошлой отправки, для всплывающей строки на сайте. */
  approved: PerformanceView[];
}

/** События потока ретранслятора (Server-Sent Events). */
export const RELAY_EVENTS = {
  snapshot: "snapshot",
  approved: "approved",
} as const;

export interface InquiryView {
  id: string;
  competitionId: string;
  performanceId: string;
  apparatus: (typeof APPARATUS)[number];
  attempt: number;
  gymnast: GymnastView;
  coach: string;
  claimedD: number | null;
  /** Оценка D на момент подачи запроса. */
  previousD: number;
  /** Новая оценка D, если запрос удовлетворён. */
  newD: number | null;
  status: InquiryStatus;
  /**
   * Подан позже срока: после того как показали оценку следующего участника
   * на этом снаряде или больше чем через 4 минуты. Решение всё равно за жюри.
   */
  late: boolean;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
}
