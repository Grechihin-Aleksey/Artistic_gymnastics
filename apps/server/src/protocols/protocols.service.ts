import {
  Inject,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  apparatusFor,
  defaultDrop,
  fromPoints,
  rotationOrder,
  shiftApparatus,
  type Apparatus,
} from "@ag/scoring";
import { APPARATUS_NAMES, type GymnastView } from "@ag/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type {
  Content,
  TableCell,
  TDocumentDefinitions,
} from "pdfmake/interfaces";
import { CompetitionsService } from "../competitions/competitions.service";
import { DB, type Db } from "../db/db.module";
import {
  categories,
  gymnasts,
  inquiries,
  judges,
  marks,
  performances,
  shifts,
  teams,
} from "../db/schema";
import { ResultsService, type CategoryScope } from "../results/results.service";
import { renderPdf } from "./pdf";
import { resultsWorkbook } from "./workbook";

const DISCIPLINE_NAMES = { MAG: "мужчины", WAG: "женщины" } as const;
const fmt = (n: number) => n.toFixed(3);
const printed = () =>
  new Date().toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" });
const fullName = (g: GymnastView) => `${g.lastName} ${g.firstName}`;

/**
 * Какие сбавки судей E отброшены как крайние (по FIG: по 2 при 7 судьях и больше,
 * по 1 при 4–6). При равных значениях отбрасывается первое по порядку мест.
 */
export function droppedDeductions(values: readonly number[]): boolean[] {
  const drop = defaultDrop(values.length);
  const order = values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v - b.v || a.i - b.i);
  const dropped = new Array<boolean>(values.length).fill(false);
  for (const { i } of [
    ...order.slice(0, drop),
    ...order.slice(order.length - drop),
  ])
    dropped[i] = true;
  return dropped;
}

interface Attempt {
  attempt: number;
  d: number;
  e: number;
  neutral: number;
  total: number;
  /** Сбавки судей E по местам; null — судья не ставил оценку. */
  eMarks: (number | null)[];
  dChanged: boolean;
}

/** Официальные протоколы соревнования в PDF. */
@Injectable()
export class ProtocolsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly competitions: CompetitionsService,
    private readonly results: ResultsService,
  ) {}

  async apparatus(
    competitionId: string,
    apparatus: Apparatus,
    scope: CategoryScope = undefined,
  ): Promise<Buffer> {
    const competition = await this.competitions.get(competitionId);
    const rows = await this.results.apparatus(
      competitionId,
      apparatus,
      "average",
      scope,
    );
    const eSeats = (
      await this.db
        .select({ seat: judges.seat })
        .from(judges)
        .where(
          and(
            eq(judges.competitionId, competitionId),
            eq(judges.apparatus, apparatus),
            eq(judges.role, "E"),
          ),
        )
        .orderBy(asc(judges.seat))
    ).map((j) => j.seat);
    const attempts = await this.attempts(competitionId, apparatus, eSeats);
    const teamNames = await this.teamNames(competitionId);
    const isVault = apparatus === "VT";

    const header: TableCell[] = [
      th("Место"),
      th("№"),
      th("Участник"),
      ...(isVault ? [th("Прыжок")] : []),
      th("D", "right"),
      ...eSeats.map((s) => th(`E${s}`, "right")),
      th("E", "right"),
      th("Сб.", "right"),
      th("Оценка", "right"),
      ...(isVault ? [th("Итог", "right")] : []),
    ];
    const body: TableCell[][] = [header];
    let changedNote = false;
    for (const row of rows) {
      const list = attempts.get(row.gymnast.id) ?? [];
      list.forEach((a, index) => {
        const first = index === 0;
        const span = first ? list.length : 1;
        const dropped = droppedDeductions(
          a.eMarks.filter((m): m is number => m !== null),
        );
        let k = 0;
        const eCells = a.eMarks.map((m): TableCell => {
          if (m === null) return { text: "—", alignment: "right" };
          const isDropped = dropped[k++];
          return {
            text: isDropped ? `(${fmt(m)})` : fmt(m),
            alignment: "right",
            color: isDropped ? "#777" : undefined,
          };
        });
        if (a.dChanged) changedNote = true;
        body.push([
          first ? { text: String(row.rank), bold: true, rowSpan: span } : {},
          first ? { text: String(row.gymnast.bib), rowSpan: span } : {},
          first
            ? { stack: gymnastStack(row.gymnast, teamNames), rowSpan: span }
            : {},
          ...(isVault
            ? [{ text: String(a.attempt), alignment: "center" } as TableCell]
            : []),
          { text: fmt(a.d) + (a.dChanged ? " *" : ""), alignment: "right" },
          ...eCells,
          { text: fmt(a.e), alignment: "right" },
          {
            text: a.neutral > 0 ? `−${fmt(a.neutral)}` : "",
            alignment: "right",
          },
          { text: fmt(a.total), alignment: "right", bold: !isVault },
          ...(isVault
            ? [
                first
                  ? ({
                      text: fmt(row.score.total),
                      alignment: "right",
                      bold: true,
                      rowSpan: span,
                    } as TableCell)
                  : {},
              ]
            : []),
        ]);
      });
    }

    const notes: string[] = [
      "В скобках — крайние сбавки судей E, не вошедшие в среднее.",
    ];
    if (isVault) notes.push("Итог опорного прыжка — среднее двух прыжков.");
    if (changedNote)
      notes.push("* Оценка D изменена апелляционным жюри по запросу тренера.");
    return renderPdf(
      this.document(
        competition,
        `Протокол: ${APPARATUS_NAMES[apparatus]}${await this.categoryTitle(competitionId, scope)}`,
        [
          rows.length === 0 ? emptyNote() : table(body),
          ...notes.map((n) => ({ text: n, style: "note" }) as Content),
        ],
      ),
    );
  }

  async allAround(
    competitionId: string,
    scope: CategoryScope = undefined,
  ): Promise<Buffer> {
    const competition = await this.competitions.get(competitionId);
    const rows = await this.results.allAround(competitionId, scope);
    const program = apparatusFor(competition.discipline);
    const teamNames = await this.teamNames(competitionId);
    const body: TableCell[][] = [
      [
        th("Место"),
        th("№"),
        th("Участник"),
        ...program.map((a) => th(APPARATUS_NAMES[a]!, "right")),
        th("Сумма", "right"),
      ],
    ];
    for (const row of rows) {
      body.push([
        { text: String(row.rank), bold: true },
        String(row.gymnast.bib),
        { stack: gymnastStack(row.gymnast, teamNames) },
        ...program.map((a): TableCell => {
          const s = row.apparatus[a];
          if (!s) return { text: "—", alignment: "right" };
          return {
            stack: [
              { text: fmt(s.total), alignment: "right" },
              {
                text: `D ${fmt(s.d)} · E ${fmt(s.e)}${s.neutral > 0 ? ` · −${fmt(s.neutral)}` : ""}`,
                style: "small",
                alignment: "right",
              },
            ],
          };
        }),
        {
          text: fmt(row.total) + (row.complete ? "" : " ¹"),
          alignment: "right",
          bold: true,
        },
      ]);
    }
    const notes = ["Опорный прыжок в многоборье — оценка за первый прыжок."];
    if (rows.some((r) => !r.complete))
      notes.push("¹ Выступил(а) не на всех снарядах.");
    return renderPdf(
      this.document(
        competition,
        `Протокол: личное многоборье${await this.categoryTitle(competitionId, scope)}`,
        [
          rows.length === 0 ? emptyNote() : table(body),
          ...notes.map((n) => ({ text: n, style: "note" }) as Content),
        ],
      ),
    );
  }

  async teams(
    competitionId: string,
    scope: CategoryScope = undefined,
  ): Promise<Buffer> {
    const competition = await this.competitions.get(competitionId);
    const program = apparatusFor(competition.discipline);
    let ranked;
    try {
      ranked = await this.results.teams(competitionId, scope);
    } catch (e) {
      if (e instanceof UnprocessableEntityException) {
        throw new UnprocessableEntityException(
          `Командный протокол не собрать: ${e.message}`,
        );
      }
      throw e;
    }
    const people = await this.results.allAround(competitionId, scope);
    const body: TableCell[][] = [
      [
        th("Место"),
        th("Команда / участник"),
        ...program.map((a) => th(APPARATUS_NAMES[a]!, "right")),
        th("Сумма", "right"),
      ],
    ];
    for (const team of ranked) {
      body.push([
        { text: String(team.rank), bold: true },
        { text: team.team.name ?? "", bold: true },
        ...program.map((a): TableCell => {
          const t = team.apparatus.find((x) => x.apparatus === a);
          return {
            text: t ? fmt(t.total) : "—",
            alignment: "right",
            bold: true,
          };
        }),
        { text: fmt(team.total), alignment: "right", bold: true },
      ]);
      const members = people
        .filter((p) => p.gymnast.teamId === team.team.id)
        .sort((a, b) => a.gymnast.bib - b.gymnast.bib);
      for (const m of members) {
        body.push([
          "",
          { text: `№${m.gymnast.bib} ${fullName(m.gymnast)}`, style: "member" },
          ...program.map((a): TableCell => {
            const s = m.apparatus[a];
            if (!s) return { text: "", style: "member" };
            const counted = team.apparatus
              .find((x) => x.apparatus === a)
              ?.counted.includes(m.gymnast.id);
            return {
              text: counted ? fmt(s.total) : `(${fmt(s.total)})`,
              alignment: "right",
              style: "member",
              color: counted ? undefined : "#777",
            };
          }),
          "",
        ]);
      }
    }
    const format = `${competition.teamRoster}-${competition.teamPerApparatus}-${competition.teamCounting}`;
    return renderPdf(
      this.document(
        competition,
        `Протокол: командное первенство${await this.categoryTitle(competitionId, scope)}`,
        [
          ranked.length === 0 ? emptyNote() : table(body, 1),
          {
            text: `Формат ${format}: в составе до ${competition.teamRoster}, на снаряде выступают до ${competition.teamPerApparatus}, в зачёт идут ${competition.teamCounting} лучших оценки.`,
            style: "note",
          },
          {
            text: "В скобках — оценки, не вошедшие в зачёт команды.",
            style: "note",
          },
        ],
      ),
    );
  }

  /** Утверждённые выступления на снаряде с оценками каждого судьи E. */
  private async attempts(
    competitionId: string,
    apparatus: Apparatus,
    eSeats: number[],
  ) {
    const perfs = await this.db
      .select()
      .from(performances)
      .where(
        and(
          eq(performances.competitionId, competitionId),
          eq(performances.apparatus, apparatus),
          eq(performances.status, "APPROVED"),
        ),
      )
      .orderBy(asc(performances.attempt));
    const ids = perfs.map((p) => p.id);
    const [markRows, changed] = ids.length
      ? await Promise.all([
          this.db
            .select({
              performanceId: marks.performanceId,
              value: marks.value,
              seat: judges.seat,
            })
            .from(marks)
            .innerJoin(judges, eq(judges.id, marks.judgeId))
            .where(and(inArray(marks.performanceId, ids), eq(marks.kind, "E"))),
          this.db
            .select({ performanceId: inquiries.performanceId })
            .from(inquiries)
            .where(
              and(
                inArray(inquiries.performanceId, ids),
                eq(inquiries.status, "ACCEPTED"),
              ),
            ),
        ])
      : [[], []];
    const changedIds = new Set(changed.map((c) => c.performanceId));
    const byGymnast = new Map<string, Attempt[]>();
    for (const p of perfs) {
      if (p.total === null) continue;
      const mine = markRows.filter((m) => m.performanceId === p.id);
      const list = byGymnast.get(p.gymnastId) ?? [];
      list.push({
        attempt: p.attempt,
        d: fromPoints(p.d ?? 0),
        e: fromPoints(p.e ?? 0),
        neutral: fromPoints(p.neutral ?? 0),
        total: fromPoints(p.total),
        eMarks: eSeats.map((seat) => {
          const m = mine.find((x) => x.seat === seat);
          return m ? fromPoints(m.value) : null;
        }),
        dChanged: changedIds.has(p.id),
      });
      byGymnast.set(p.gymnastId, list);
    }
    return byGymnast;
  }

  /** Итоги по всем разрядам в Excel. */
  async workbook(competitionId: string): Promise<Buffer> {
    const competition = await this.competitions.get(competitionId);
    const program = apparatusFor(competition.discipline);
    const list = await this.results.categoryList(competitionId);
    const categories = await Promise.all(
      list.map(async (c) => ({
        name: c.name,
        allAround: await this.results.allAround(competitionId, c.id),
        teams: await this.results
          .teams(competitionId, c.id)
          .catch((e: unknown) => {
            if (e instanceof UnprocessableEntityException) return [];
            throw e;
          }),
        apparatus: await Promise.all(
          program.map(async (code) => ({
            code,
            rows: await this.results.apparatus(
              competitionId,
              code,
              "average",
              c.id,
            ),
          })),
        ),
      })),
    );
    return resultsWorkbook(
      competition.name,
      program,
      categories,
      await this.teamNames(competitionId),
    );
  }

  /**
   * Стартовый протокол: порядок ротаций и состав смен в порядке выхода.
   * Без смен — участники по разрядам и номерам.
   */
  async startList(competitionId: string): Promise<Buffer> {
    const competition = await this.competitions.get(competitionId);
    const { people, shiftRows, categoryNames, teamNames } =
      await this.roster(competitionId);
    const program = apparatusFor(competition.discipline);
    const content: Content[] = [];
    const row = (g: (typeof people)[number], i: number): TableCell[] => [
      String(i + 1),
      String(g.bib),
      { text: `${g.lastName} ${g.firstName}`, bold: true },
      g.club ?? "",
      g.teamId ? (teamNames.get(g.teamId) ?? "") : "",
      g.categoryId ? (categoryNames.get(g.categoryId) ?? "") : "",
    ];
    const header = (): TableCell[] => [
      th("п/п"),
      th("№"),
      th("Участник"),
      th("Клуб"),
      th("Команда"),
      th("Разряд"),
    ];

    if (shiftRows.length > 0) {
      content.push(
        { text: "Порядок ротаций", style: "section" },
        table(
          [
            [th("Ротация"), ...shiftRows.map((s) => th(`Смена ${s.number}`))],
            ...program.map((_, r) => [
              String(r + 1),
              ...shiftRows.map(
                (s) =>
                  APPARATUS_NAMES[
                    shiftApparatus(competition.discipline, s.startApparatus, r)
                  ]!,
              ),
            ]),
          ],
          -1,
        ),
      );
      for (const s of shiftRows) {
        const members = people.filter((g) => g.shift === s.number);
        content.push(
          {
            text: `Смена ${s.number} · начинает: ${APPARATUS_NAMES[s.startApparatus]}`,
            style: "section",
          },
          members.length === 0
            ? emptyList()
            : table([header(), ...members.map(row)]),
        );
      }
      const unassigned = people.filter((g) => g.shift === null);
      if (unassigned.length > 0) {
        content.push(
          { text: "Без смены", style: "section" },
          table([header(), ...unassigned.map(row)]),
        );
      }
      content.push({
        text: "Порядок выхода указан для первой ротации. По правилам FIG после каждой ротации первый участник смены выступает последним.",
        style: "note",
      });
    } else {
      const groups = new Map<string | null, typeof people>();
      for (const g of [...people].sort((a, b) => a.bib - b.bib)) {
        groups.set(g.categoryId, [...(groups.get(g.categoryId) ?? []), g]);
      }
      for (const [categoryId, members] of groups) {
        if (groups.size > 1 || categoryId) {
          content.push({
            text: categoryId ? categoryNames.get(categoryId)! : "Без разряда",
            style: "section",
          });
        }
        content.push(table([header(), ...members.map(row)]));
      }
      if (people.length === 0) content.push(emptyList());
    }
    return renderPdf(this.document(competition, "Стартовый протокол", content));
  }

  /**
   * Судейская ведомость снаряда: участники в порядке выхода по ротациям
   * и пустые графы для оценок — запасной вариант на бумаге.
   */
  async apparatusSheet(
    competitionId: string,
    apparatus: Apparatus,
  ): Promise<Buffer> {
    const competition = await this.competitions.get(competitionId);
    if (!apparatusFor(competition.discipline).includes(apparatus)) {
      throw new UnprocessableEntityException(
        `Снаряда ${apparatus} нет в программе ${competition.discipline}`,
      );
    }
    const { people, shiftRows, categoryNames } =
      await this.roster(competitionId);
    const eCount =
      (
        await this.db
          .select({ id: judges.id })
          .from(judges)
          .where(
            and(
              eq(judges.competitionId, competitionId),
              eq(judges.apparatus, apparatus),
              eq(judges.role, "E"),
            ),
          )
      ).length || 5;
    const header = (): TableCell[] => [
      th("п/п"),
      th("№"),
      th("Участник"),
      th("D", "right"),
      ...Array.from({ length: eCount }, (_, i) => th(`E${i + 1}`, "right")),
      th("НС", "right"),
      th("Итог", "right"),
    ];
    const fixed: Record<number, number> = {
      3: 38,
      [4 + eCount]: 34,
      [5 + eCount]: 44,
    };
    for (let i = 0; i < eCount; i++) fixed[4 + i] = 34;
    const blank = Array.from({ length: eCount + 3 }, () => "");
    const sheet = (list: typeof people) =>
      table(
        [
          header(),
          ...list.map((g, i): TableCell[] => [
            String(i + 1),
            String(g.bib),
            {
              stack: [
                { text: `${g.lastName} ${g.firstName}`, bold: true },
                ...(g.categoryId
                  ? [
                      {
                        text: categoryNames.get(g.categoryId) ?? "",
                        style: "small",
                      },
                    ]
                  : []),
              ],
            },
            ...blank,
          ]),
        ],
        2,
        fixed,
      );

    const content: Content[] = [];
    if (shiftRows.length > 0) {
      apparatusFor(competition.discipline).forEach((_, r) => {
        for (const s of shiftRows) {
          if (
            shiftApparatus(competition.discipline, s.startApparatus, r) !==
            apparatus
          )
            continue;
          const members = rotationOrder(
            people.filter((g) => g.shift === s.number),
            r,
          );
          content.push(
            { text: `Ротация ${r + 1} · смена ${s.number}`, style: "section" },
            sheet(members),
          );
        }
      });
      if (content.length === 0) content.push(emptyList());
    } else {
      content.push(
        people.length === 0
          ? emptyList()
          : sheet([...people].sort((a, b) => a.bib - b.bib)),
      );
    }
    content.push({ text: "НС — нейтральная сбавка.", style: "note" });
    return renderPdf(
      this.document(
        competition,
        `Судейская ведомость: ${APPARATUS_NAMES[apparatus]}`,
        content,
      ),
    );
  }

  /** Участники в порядке выхода, смены, названия разрядов и команд. */
  private async roster(competitionId: string) {
    const [people, shiftRows, categoryRows, teamNames] = await Promise.all([
      this.db
        .select()
        .from(gymnasts)
        .where(eq(gymnasts.competitionId, competitionId))
        .orderBy(asc(gymnasts.startOrder), asc(gymnasts.bib)),
      this.db
        .select()
        .from(shifts)
        .where(eq(shifts.competitionId, competitionId))
        .orderBy(asc(shifts.number)),
      this.db
        .select()
        .from(categories)
        .where(eq(categories.competitionId, competitionId)),
      this.teamNames(competitionId),
    ]);
    return {
      people,
      shiftRows,
      categoryNames: new Map(categoryRows.map((c) => [c.id, c.name])),
      teamNames,
    };
  }

  /** Приписка к заголовку протокола с названием разряда. */
  private async categoryTitle(
    competitionId: string,
    scope: CategoryScope,
  ): Promise<string> {
    if (scope === undefined) return "";
    if (scope === null) return " · без разряда";
    const [row] = await this.db
      .select({ name: categories.name })
      .from(categories)
      .where(
        and(
          eq(categories.id, scope),
          eq(categories.competitionId, competitionId),
        ),
      );
    return row ? ` · ${row.name}` : "";
  }

  private async teamNames(competitionId: string) {
    const rows = await this.db
      .select()
      .from(teams)
      .where(eq(teams.competitionId, competitionId));
    return new Map(rows.map((t) => [t.id, t.name]));
  }

  private document(
    competition: {
      name: string;
      discipline: keyof typeof DISCIPLINE_NAMES;
      logo?: string | null;
    },
    title: string,
    content: Content[],
  ): TDocumentDefinitions {
    const heading: Content[] = [
      { text: competition.name, style: "competition" },
      {
        text: `${title} · ${DISCIPLINE_NAMES[competition.discipline]}`,
        style: "title",
      },
      { text: `Сформирован ${printed()}`, style: "meta" },
    ];
    return {
      pageSize: "A4",
      pageOrientation: "landscape",
      pageMargins: [36, 40, 36, 56],
      info: { title: `${competition.name}. ${title}` },
      defaultStyle: { font: "Roboto", fontSize: 9 },
      styles: {
        competition: { fontSize: 15, bold: true },
        title: { fontSize: 12, margin: [0, 2, 0, 0] },
        meta: { fontSize: 8, color: "#555", margin: [0, 2, 0, 10] },
        th: { bold: true, fontSize: 8, fillColor: "#eeeeee" },
        small: { fontSize: 7, color: "#555" },
        member: { fontSize: 8 },
        note: { fontSize: 8, color: "#555", margin: [0, 6, 0, 0] },
        section: { fontSize: 11, bold: true, margin: [0, 12, 0, 4] },
      },
      content: [
        competition.logo
          ? {
              columns: [
                { image: competition.logo, fit: [64, 64], width: 76 },
                { stack: heading, width: "*" },
              ],
            }
          : { stack: heading },
        ...content,
        {
          margin: [0, 28, 0, 0],
          columns: [
            { text: "Главный судья ______________________" },
            { text: "Главный секретарь ______________________" },
          ],
        },
      ],
      footer: (page, pages) => ({
        text: `${competition.name} · ${title} · стр. ${page} из ${pages}`,
        alignment: "center",
        fontSize: 7,
        color: "#777",
        margin: [0, 20, 0, 0],
      }),
    };
  }
}

function th(text: string, alignment: "left" | "right" = "left"): TableCell {
  return { text, style: "th", alignment };
}

function gymnastStack(
  g: GymnastView,
  teamNames?: Map<string, string>,
): Content[] {
  const club = [g.club, g.teamId ? teamNames?.get(g.teamId) : undefined].filter(
    Boolean,
  );
  const unique = [...new Set(club)].join(" · ");
  return [
    { text: fullName(g), bold: true },
    ...(unique ? [{ text: unique, style: "small" }] : []),
  ];
}

/** nameIndex — колонка с именем: она тянется на свободное место, остальные по содержимому. */
function table(
  body: TableCell[][],
  nameIndex = 2,
  fixed: Record<number, number> = {},
): Content {
  return {
    table: {
      headerRows: 1,
      dontBreakRows: true,
      widths: body[0]!.map(
        (_, i) => fixed[i] ?? (i === nameIndex ? "*" : "auto"),
      ),
      body,
    },
    layout: {
      hLineWidth: (i: number) => (i <= 1 ? 1 : 0.5),
      vLineWidth: () => 0,
      hLineColor: () => "#bbbbbb",
      paddingTop: () => 4,
      paddingBottom: () => 4,
    },
  };
}

function emptyList(): Content {
  return { text: "Участников нет.", italics: true, margin: [0, 6, 0, 0] };
}

function emptyNote(): Content {
  return {
    text: "Утверждённых оценок пока нет.",
    italics: true,
    margin: [0, 10, 0, 0],
  };
}
