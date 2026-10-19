import { z } from "zod";

export const DISCIPLINES = ["MAG", "WAG"] as const;
export const APPARATUS = ["FX", "PH", "SR", "VT", "PB", "HB", "UB", "BB"] as const;
export const JUDGE_ROLES = ["D", "E", "SUPERVISOR"] as const;
export const MARK_KINDS = ["D", "E", "NEUTRAL"] as const;
export const PERFORMANCE_STATUSES = ["SCORING", "APPROVED"] as const;

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

export const reopenPerformanceSchema = z.object({
  reason: z.string().min(1).max(500),
});

export type CreateCompetitionInput = z.infer<typeof createCompetitionSchema>;
export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type CreateGymnastInput = z.infer<typeof createGymnastSchema>;
export type CreateJudgeInput = z.infer<typeof createJudgeSchema>;
export type CreatePerformanceInput = z.infer<typeof createPerformanceSchema>;
export type SubmitMarkInput = z.infer<typeof submitMarkSchema>;
export type ReopenPerformanceInput = z.infer<typeof reopenPerformanceSchema>;

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
