import { z } from "zod";

export const DISCIPLINES = ["MAG", "WAG"] as const;
export const APPARATUS = ["FX", "PH", "SR", "VT", "PB", "HB", "UB", "BB"] as const;
export const JUDGE_ROLES = ["D", "E", "SUPERVISOR"] as const;
export const MARK_KINDS = ["D", "E", "NEUTRAL"] as const;
export const PERFORMANCE_STATUSES = ["SCORING", "APPROVED"] as const;
export const INQUIRY_STATUSES = ["PENDING", "ACCEPTED", "REJECTED"] as const;
/** Этап: квалификация (многоборье) или финалы на отдельных снарядах. */
export const STAGES = ["QUAL", "FINAL"] as const;
export type Stage = (typeof STAGES)[number];

/** Участник выступает, не явился или снялся по ходу соревнований. */
export const GYMNAST_STATUSES = ["ACTIVE", "DNS", "WITHDRAWN"] as const;
export type GymnastStatus = (typeof GYMNAST_STATUSES)[number];
export const GYMNAST_STATUS_NAMES: Readonly<Record<GymnastStatus, string>> = {
  ACTIVE: "выступает",
  DNS: "неявка",
  WITHDRAWN: "снятие",
};
/** Правила судейства: FIG или свои (база по разряду минус сбавки). */
export const RULES = ["FIG", "CUSTOM"] as const;
export type Rules = (typeof RULES)[number];

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
  rules: z.enum(RULES).default("FIG"),
});

export const createTeamSchema = z.object({
  name: z.string().min(1).max(200),
});

/** Дата рождения: год (2012) или полная дата (15.03.2012). */
export const birthDateSchema = z
  .string()
  .trim()
  .regex(/^(\d{4}|\d{2}\.\d{2}\.\d{4})$/, "Дата рождения: год (2012) или дата (15.03.2012)");

/** Год рождения из даты рождения: для протоколов («г.р.»). */
export const birthYear = (birthDate: string | null | undefined): string => birthDate?.slice(-4) ?? "";

/** Необязательные сведения об участнике: отчество, дата рождения, город, тренер. */
const gymnastDetails = {
  middleName: z.string().trim().max(100).optional(),
  birthDate: birthDateSchema.optional(),
  city: z.string().trim().max(200).optional(),
  coach: z.string().trim().max(200).optional(),
};

export const createGymnastSchema = z.object({
  bib: z.number().int().min(1),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  club: z.string().max(200).optional(),
  teamId: z.uuid().optional(),
  ...gymnastDetails,
});

/** Судейские категории: всероссийская, первая, вторая, третья, юный судья. */
export const JUDGE_CATEGORIES = ["ВК", "1К", "2К", "3К", "ЮС"] as const;

/** Главный судья или главный секретарь: ФИО, судейская категория, город. */
export const officialSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(40).optional(),
  city: z.string().trim().max(100).optional(),
});

export const setOfficialsSchema = z.object({
  chiefJudge: officialSchema.nullable(),
  chiefSecretary: officialSchema.nullable(),
});

/** «Иванова А. А. (ВК, Тверь)» — для подписей в протоколах. */
export function officialLabel(o: { name: string; category?: string | null; city?: string | null }): string {
  const extra = [o.category, o.city].filter(Boolean).join(", ");
  return extra ? `${o.name} (${extra})` : o.name;
}

export const createJudgeSchema = z.object({
  name: z.string().min(1).max(200),
  /** Судейская категория: ВК, 1К, 2К, 3К, ЮС или своя запись. */
  category: z.string().trim().max(40).optional(),
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
        ...gymnastDetails,
      }),
    )
    .min(1)
    .max(1000),
});

/** Строка онлайн-заявки клуба: участник без номера, номер даст секретариат. */
export const onlineEntryRowSchema = z.object({
  lastName: z.string().trim().min(1, "Укажите фамилию").max(100),
  firstName: z.string().trim().min(1, "Укажите имя").max(100),
  /** Разряд или возрастная группа из списка соревнования. */
  category: z.string().trim().max(100).optional(),
  team: z.string().trim().max(200).optional(),
  ...gymnastDetails,
});

/** Онлайн-заявка клуба с сайта соревнования. */
export const onlineEntrySchema = z.object({
  club: z.string().trim().min(1, "Укажите клуб").max(200),
  city: z.string().trim().max(200).optional(),
  /** Кто подаёт заявку и как с ним связаться. */
  contact: z.string().trim().min(3, "Укажите контакт: ФИО и телефон или почту").max(300),
  comment: z.string().trim().max(1000).optional(),
  rows: z.array(onlineEntryRowSchema).min(1, "Добавьте хотя бы одного участника").max(100),
});

/** Приём онлайн-заявок, который зал публикует на ретрансляторе. */
export interface OnlineEntryCall {
  name: string;
  discipline: (typeof DISCIPLINES)[number];
  open: boolean;
  /** ISO-время окончания приёма или null. */
  deadline: string | null;
  /** Разряды соревнования для выбора в заявке. */
  categories: string[];
}

/** Заявка, принятая ретранслятором: id и время получения ставит он. */
export type OnlineEntry = z.infer<typeof onlineEntrySchema>;
export interface ReceivedOnlineEntry extends OnlineEntry {
  id: string;
  receivedAt: string;
}

export const ONLINE_ENTRY_STATUSES = ["NEW", "ACCEPTED", "REJECTED"] as const;
export type OnlineEntryStatus = (typeof ONLINE_ENTRY_STATUSES)[number];

/** Онлайн-заявки в секретариате. */
export interface OnlineEntriesView {
  /** Ретранслятор настроен (RELAY_URL и RELAY_TOKEN): без него онлайн-заявок нет. */
  enabled: boolean;
  open: boolean;
  deadline: string | null;
  /** Ссылка для клубов. */
  link: string | null;
  /** Когда последний раз забирали заявки с ретранслятора. */
  syncedAt: string | null;
  entries: (ReceivedOnlineEntry & { status: OnlineEntryStatus; note: string | null; decidedAt: string | null })[];
}

export const setOnlineEntriesSchema = z.object({
  open: z.boolean(),
  deadline: z.iso.datetime({ offset: true }).nullable().default(null),
});

export const rejectOnlineEntrySchema = z.object({ note: z.string().trim().max(500).optional() });

/**
 * Правка участника. Разряд, команда и смена — по названию (номеру), как при импорте;
 * пустая строка или null убирает. Не переданные поля не меняются.
 */
export const updateGymnastSchema = z.object({
  bib: z.number().int().min(1).max(100_000).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  firstName: z.string().trim().min(1).max(100).optional(),
  club: z.string().trim().max(200).nullable().optional(),
  team: z.string().trim().max(200).nullable().optional(),
  category: z.string().trim().max(100).nullable().optional(),
  shift: z.number().int().min(1).max(50).nullable().optional(),
  status: z.enum(GYMNAST_STATUSES).optional(),
  middleName: z.string().trim().max(100).nullable().optional(),
  birthDate: birthDateSchema.nullable().optional(),
  city: z.string().trim().max(200).nullable().optional(),
  coach: z.string().trim().max(200).nullable().optional(),
});

/** Логотип соревнования: картинка PNG или JPEG как data URL, не больше ~1,5 МБ. */
export const setLogoSchema = z.object({
  dataUrl: z
    .string()
    .max(2_000_000)
    .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/, "Нужна картинка PNG или JPEG"),
});

/**
 * Правила судейства. При своих правилах у каждого разряда базовая оценка
 * (одна на все снаряды, при необходимости своя на отдельных снарядах),
 * а судья D или старший судья ставит сбавки за требования из списка.
 */
export const setRulesSchema = z.object({
  rules: z.enum(RULES),
  deductions: z
    .array(z.object({ name: z.string().trim().min(1).max(100), value: score.max(10).positive() }))
    .max(40)
    .default([]),
  bases: z
    .array(
      z.object({
        categoryId: z.uuid(),
        base: score.nullable(),
        apparatus: z.partialRecord(apparatusSchema, score).default({}),
      }),
    )
    .default([]),
});

/**
 * Нормативы разрядов: в каждом разряде соревнований — уровни с минимальной суммой
 * многоборья, например «1 юношеский» от 48.000, «2 юношеский» от 44.000.
 * Участник, выступивший на всех снарядах, выполняет высший уровень, до которого набрал.
 */
export const setNormativesSchema = z.object({
  categories: z
    .array(
      z.object({
        categoryId: z.uuid(),
        levels: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(60),
              min: z.number().positive().max(200).multipleOf(0.001),
            }),
          )
          .max(6),
      }),
    )
    .max(50),
});

/** Очки за 1-е, 2-е, 3-е… места; дальше списка мест — 0 очков. */
const placePoints = z.array(z.number().min(0).max(1000).multipleOf(0.5)).max(60);

/**
 * Общекомандный зачёт клубов: очки за места участников в многоборье, на снарядах
 * (в финале, если он был) и команд — по таблицам из положения. best — сколько
 * лучших результатов клуба в многоборье в каждом разряде идёт в зачёт (null — все).
 */
export const setClubStandingSchema = z.object({
  allAround: placePoints,
  apparatus: placePoints,
  teams: placePoints,
  best: z.number().int().min(1).max(50).nullable(),
});

/** Что награждают: многоборье, снаряд, команды разряда или общекомандный зачёт клубов. */
export const CEREMONY_KINDS = ["allAround", "apparatus", "teams", "clubs"] as const;

/**
 * Экран награждения на табло. categoryId — разряд (null, если разрядов нет;
 * для клубов не нужен), apparatus — только для награждения на снаряде.
 */
export const ceremonySchema = z
  .object({
    kind: z.enum(CEREMONY_KINDS),
    categoryId: z.uuid().nullable().default(null),
    apparatus: apparatusSchema.optional(),
  })
  .refine((c) => (c.kind === "apparatus") === (c.apparatus !== undefined), {
    message: "Снаряд указывается только для награждения на снаряде",
    path: ["apparatus"],
  });

/** null — убрать награждение с табло. */
export const setCeremonySchema = z.object({ ceremony: ceremonySchema.nullable() });

/** Файл заявки Excel (.xlsx) в base64. */
export const parseEntriesSchema = z.object({
  file: z.string().min(1).max(6_000_000).regex(/^[A-Za-z0-9+/]+=*$/, "Нужен файл в base64"),
  /** С какого номера раздавать стартовые номера: после уже вставленных в поле списка. */
  nextBib: z.number().int().min(1).max(1_000_000).optional(),
});

/**
 * Жеребьёвка стартовых номеров. Случайная — номера по порядку от firstBib в
 * случайном порядке внутри каждой смены (без смен — внутри разряда); участники
 * одной команды при keepTeams выходят подряд. Ручная — секретарь сам ставит номера.
 * Порядок выхода в смене — по возрастанию номеров.
 */
export const drawSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("random"),
    firstBib: z.number().int().min(1).max(100_000).default(1),
    keepTeams: z.boolean().default(true),
  }),
  z.object({
    mode: z.literal("manual"),
    bibs: z
      .array(z.object({ gymnastId: z.uuid(), bib: z.number().int().min(1).max(100_000) }))
      .min(1)
      .max(2000),
  }),
]);

/**
 * Финалы на снарядах: в каждом разряде на каждом снаряде лучшие size участников
 * квалификации (при равенстве на границе проходят все), не больше perClub от клуба,
 * и reserves запасных. Порядок выступления в финале — жеребьёвка.
 */
export const createFinalsSchema = z.object({
  size: z.number().int().min(1).max(16).default(8),
  reserves: z.number().int().min(0).max(5).default(2),
  perClub: z.number().int().min(1).max(16).nullable().default(null),
});

export const setPhaseSchema = z.object({ phase: z.enum(STAGES) });

/** Финалист снимается, его место в порядке выступления занимает первый запасной. */
export const replaceFinalistSchema = z.object({ gymnastId: z.uuid() });

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
export type SetLogoInput = z.infer<typeof setLogoSchema>;
export type SetRulesInput = z.infer<typeof setRulesSchema>;
export type SetNormativesInput = z.infer<typeof setNormativesSchema>;
export type SetOnlineEntriesInput = z.infer<typeof setOnlineEntriesSchema>;
export type RejectOnlineEntryInput = z.infer<typeof rejectOnlineEntrySchema>;
export type ClubStandingSettings = z.infer<typeof setClubStandingSchema>;
export type Ceremony = z.infer<typeof ceremonySchema>;
export type SetCeremonyInput = z.infer<typeof setCeremonySchema>;
export type Official = z.infer<typeof officialSchema>;
export type SetOfficialsInput = z.infer<typeof setOfficialsSchema>;
export type ParseEntriesInput = z.infer<typeof parseEntriesSchema>;
export type UpdateGymnastInput = z.infer<typeof updateGymnastSchema>;
export type CreateFinalsInput = z.infer<typeof createFinalsSchema>;
export type SetPhaseInput = z.infer<typeof setPhaseSchema>;
export type ReplaceFinalistInput = z.infer<typeof replaceFinalistSchema>;
export type DrawInput = z.infer<typeof drawSchema>;
export type SetShiftStartInput = z.infer<typeof setShiftStartSchema>;
export type SetRotationInput = z.infer<typeof setRotationSchema>;
export type CreateInquiryInput = z.infer<typeof createInquirySchema>;
export type ResolveInquiryInput = z.infer<typeof resolveInquirySchema>;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

export interface FinalistView {
  gymnast: GymnastView;
  /** Порядок выступления в финале; у запасных — очередь запасных. */
  position: number;
  reserve: boolean;
  /** Место и оценка в квалификации на этом снаряде. */
  qualRank: number;
  qualTotal: number;
}

export interface FinalsView {
  phase: Stage;
  size: number;
  reserves: number;
  perClub: number | null;
  /** Финальные оценки уже есть: состав не пересобрать. */
  started: boolean;
  lists: {
    apparatus: (typeof APPARATUS)[number];
    category: { id: string | null; name: string };
    finalists: FinalistView[];
  }[];
}

export interface DrawView {
  /** Оценки уже ставятся: номера не меняются. */
  started: boolean;
  /** Последняя жеребьёвка: случайная или ручная, когда (ISO). */
  last: { mode: "random" | "manual"; at: string } | null;
}

export interface NormativesView {
  /** Уровни каждого разряда — от высшего к низшему. */
  categories: { id: string; name: string; levels: { name: string; min: number }[] }[];
}

export interface RulesView {
  rules: Rules;
  deductions: { name: string; value: number }[];
  categories: {
    id: string;
    name: string;
    base: number | null;
    apparatus: Partial<Record<(typeof APPARATUS)[number], number>>;
    /** В разряде уже есть оценки: базу менять нельзя. */
    scored: boolean;
  }[];
  /** Оценки уже есть: правила не переключить. */
  scored: boolean;
}

/**
 * Подписи колонок оценки. По своим правилам d — стоимость упражнения
 * (база − требования), e — средняя сбавка E со знаком минус: показываем её модулем.
 */
export function scoreLabels(rules: Rules | undefined): { d: string; e: string } {
  return rules === "CUSTOM" ? { d: "Стоимость", e: "Сбавка" } : { d: "D", e: "E" };
}

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
  /** Квалификация или финал на снаряде. */
  stage: Stage;
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
  /** Сервер → все: сформированы финалы, заменён финалист или сменился этап. */
  finals: "competition.finals",
  /** Сервер → все: секретариат вывел награждение на табло или убрал его. */
  ceremony: "competition.ceremony",
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
  /** Выполненный разряд по нормативам разряда соревнований, если он задан и выполнен. */
  earned?: string | null;
}

export interface ClubStandingRow {
  rank: number;
  /** Клуб участника, а без клуба — его команда. */
  club: string;
  total: number;
  allAround: number;
  apparatus: number;
  teams: number;
  /** Сколько 1-х, 2-х и 3-х мест: решают при равенстве очков. */
  places: [number, number, number];
}

/** Разделы журнала изменений: оценки, запросы тренеров, участники, организация. */
export const AUDIT_GROUPS = ["marks", "inquiries", "roster", "setup"] as const;
export type AuditGroup = (typeof AUDIT_GROUPS)[number];
export const AUDIT_GROUP_NAMES: Readonly<Record<AuditGroup, string>> = {
  marks: "Оценки",
  inquiries: "Запросы тренеров",
  roster: "Участники",
  setup: "Организация",
};

/** Запись журнала изменений для секретариата и жюри, уже понятным текстом. */
export interface AuditEntry {
  id: string;
  /** ISO-время записи. */
  at: string;
  /** «Секретариат» или судья: «Судья E2 · Иванова А. А.» (снаряд — в apparatus). */
  actor: string;
  group: AuditGroup;
  action: string;
  apparatus: (typeof APPARATUS)[number] | null;
  /** «№12 Петрова Анна», если запись об участнике. */
  gymnast: string | null;
  text: string;
}

/** Пьедестал для табло: призёры 1–3 мест (при равенстве — все, кто делит место). */
export interface CeremonyView {
  /** Например: «Многоборье · КМС», «Финал: Бревно · 1 разряд», «Общекомандный зачёт». */
  title: string;
  podium: { place: number; name: string; detail: string | null; total: number }[];
  /** Для клубов total — очки, а не сумма баллов. */
  points: boolean;
}

export interface ClubStandingView {
  settings: ClubStandingSettings;
  rows: ClubStandingRow[];
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
  /** phase FINAL — идут финалы: таблицы снарядов показывают финальные оценки. */
  competition: { id: string; name: string; discipline: (typeof DISCIPLINES)[number]; rules?: Rules; phase?: Stage };
  live: LiveApparatus[];
  /** Таблицы по разрядам. Если разрядов нет — одна запись с id null и пустым именем. */
  categories: CategoryResults[];
  /** Идёт награждение: табло в авторежиме показывает пьедестал. */
  ceremony?: CeremonyView | null;
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
