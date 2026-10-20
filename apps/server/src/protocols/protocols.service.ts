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
import {
  APPARATUS_NAMES,
  GYMNAST_STATUS_NAMES,
  birthYear,
  officialLabel,
  scoreLabels,
  AUDIT_GROUP_NAMES,
  type AuditGroup,
  type GymnastView,
  type Official,
  type Stage,
} from "@ag/shared";
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
import { AuditService } from "../audit/audit.service";
import { FinalsService } from "../finals/finals.service";
import { ResultsService, type CategoryScope } from "../results/results.service";
import ExcelJS from "exceljs";
import { renderPdf } from "./pdf";
import { resultsWorkbook } from "./workbook";
import { APPARATUS_EVENT, diplomasDocument, type Diploma } from "./diplomas";

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
    private readonly finals: FinalsService,
    private readonly audit: AuditService,
  ) {}

  async apparatus(
    competitionId: string,
    apparatus: Apparatus,
    scope: CategoryScope = undefined,
    stage: Stage = "QUAL",
  ): Promise<Buffer> {
    const competition = await this.competitions.get(competitionId);
    const rows = await this.results.apparatus(
      competitionId,
      apparatus,
      "average",
      scope,
      stage,
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
    const attempts = await this.attempts(competitionId, apparatus, eSeats, stage);
    const teamNames = await this.teamNames(competitionId);
    const isVault = apparatus === "VT";
    const custom = competition.rules === "CUSTOM";
    const labels = scoreLabels(competition.rules);

    const header: TableCell[] = [
      th("Место"),
      th("№"),
      th("Участник"),
      ...(isVault ? [th("Прыжок")] : []),
      th(labels.d, "right"),
      ...eSeats.map((s) => th(`E${s}`, "right")),
      th(labels.e, "right"),
      th(custom ? "НС" : "Сб.", "right"),
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
          // По своим правилам e — средняя сбавка со знаком минус.
          { text: fmt(Math.abs(a.e)), alignment: "right" },
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
    if (custom)
      notes.push(
        "Стоимость — базовая оценка разряда минус сбавки за требования. Сбавка — средняя сбавка судей E. НС — нейтральная сбавка.",
      );
    if (isVault) notes.push("Итог опорного прыжка — среднее двух прыжков.");
    const panel = await this.panel(competitionId, apparatus);
    if (panel) notes.push(`Судейская бригада: ${panel}.`);
    if (changedNote)
      notes.push(
        `* ${custom ? "Стоимость" : "Оценка D"} изменена апелляционным жюри по запросу тренера.`,
      );
    return renderPdf(
      this.document(
        competition,
        `${stage === "FINAL" ? "Финал" : "Протокол"}: ${APPARATUS_NAMES[apparatus]}${await this.categoryTitle(competitionId, scope)}`,
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
    // Столбец выполненного разряда — если в разряде заданы нормативы.
    const withNormatives = (
      await this.db.select().from(categories).where(eq(categories.competitionId, competitionId))
    ).some((c) => c.normatives.length > 0 && (scope === undefined || c.id === scope));
    const body: TableCell[][] = [
      [
        th("Место"),
        th("№"),
        th("Участник"),
        ...program.map((a) => th(APPARATUS_NAMES[a]!, "right")),
        th("Сумма", "right"),
        ...(withNormatives ? [th("Вып. разряд")] : []),
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
                text:
                  competition.rules === "CUSTOM"
                    ? `${fmt(s.d)} − ${fmt(Math.abs(s.e))}${s.neutral > 0 ? ` − ${fmt(s.neutral)}` : ""}`
                    : `D ${fmt(s.d)} · E ${fmt(s.e)}${s.neutral > 0 ? ` · −${fmt(s.neutral)}` : ""}`,
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
        ...(withNormatives ? [{ text: row.earned ?? "", style: "small" } as TableCell] : []),
      ]);
    }
    const notes = ["Опорный прыжок в многоборье — оценка за первый прыжок."];
    if (rows.some((r) => !r.complete))
      notes.push("¹ Выступил(а) не на всех снарядах.");
    const out = await this.db
      .select()
      .from(gymnasts)
      .where(
        and(
          eq(gymnasts.competitionId, competitionId),
          inArray(gymnasts.status, ["DNS", "WITHDRAWN"]),
        ),
      )
      .orderBy(asc(gymnasts.bib));
    for (const status of ["DNS", "WITHDRAWN"] as const) {
      const list = out.filter(
        (g) =>
          g.status === status &&
          (scope === undefined || g.categoryId === scope),
      );
      if (list.length > 0)
        notes.push(
          `${status === "DNS" ? "Не явились" : "Сняты с соревнований"}: ${list
            .map((g) => `№${g.bib} ${g.lastName} ${g.firstName}`)
            .join(", ")}.`,
        );
    }
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

  /** Бригада снаряда одной строкой: «Старший судья — Иванова А. А. (1К); D1 — …; E1 — …». */
  private async panel(competitionId: string, apparatus: Apparatus): Promise<string> {
    const rows = await this.db
      .select()
      .from(judges)
      .where(and(eq(judges.competitionId, competitionId), eq(judges.apparatus, apparatus)))
      .orderBy(asc(judges.role), asc(judges.seat));
    const order = { SUPERVISOR: 0, D: 1, E: 2 } as const;
    return rows
      .sort((a, b) => order[a.role] - order[b.role] || a.seat - b.seat)
      .map((j) => `${j.role === "SUPERVISOR" ? "Старший судья" : `${j.role}${j.seat}`} — ${officialLabel(j)}`)
      .join("; ");
  }

  /** Общекомандный зачёт клубов: очки по видам и места. */
  async clubs(competitionId: string): Promise<Buffer> {
    const competition = await this.competitions.get(competitionId);
    const { settings, rows } = await this.results.clubs(competitionId);
    const parts = [
      ["allAround", "Многоборье"],
      ["apparatus", "Снаряды"],
      ["teams", "Команды"],
    ] as const;
    const used = parts.filter(([key]) => settings[key].length > 0);
    const points = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
    const body: TableCell[][] = [
      [
        th("Место"),
        th("Клуб"),
        ...used.map(([, title]) => th(title, "right")),
        th("1-х / 2-х / 3-х мест", "right"),
        th("Очки", "right"),
      ],
      ...rows.map((r): TableCell[] => [
        { text: String(r.rank), bold: true },
        { text: r.club, bold: true },
        ...used.map(([key]): TableCell => ({ text: points(r[key]), alignment: "right" })),
        { text: r.places.join(" / "), alignment: "right" },
        { text: points(r.total), alignment: "right", bold: true },
      ]),
    ];
    const notes = used.map(
      ([key, title]) => `${title}: очки за места ${settings[key].map(points).join("; ")}, дальше — 0.`,
    );
    if (settings.best !== null && settings.allAround.length > 0) {
      notes.push(`В многоборье в каждом разряде в зачёт идут лучшие результаты клуба, не больше ${settings.best}.`);
    }
    notes.push("Места на снарядах — по финалу, если он проводился. При равенстве очков выше клуб с бо́льшим числом 1-х, затем 2-х и 3-х мест.");
    const content: Content[] =
      used.length === 0
        ? [{ text: "Общекомандный зачёт не настроен: задайте очки за места в блоке «Общекомандный зачёт».", style: "note" }]
        : [rows.length === 0 ? emptyNote() : table(body, 1), ...notes.map((n) => ({ text: n, style: "note" }) as Content)];
    return renderPdf(this.document(competition, "Общекомандный зачёт", content));
  }

  /** Журнал изменений для жюри: по времени, с исполнителем, снарядом и участником. */
  async auditLog(competitionId: string, group?: AuditGroup): Promise<Buffer> {
    const competition = await this.competitions.get(competitionId);
    const entries = (await this.audit.list(competitionId, group)).reverse();
    const body: TableCell[][] = [
      [th("Время"), th("Кто"), th("Снаряд"), th("Участник"), th("Что произошло")],
      ...entries.map((e): TableCell[] => [
        { text: auditTime(e.at), noWrap: true },
        { text: e.actor },
        { text: e.apparatus ? APPARATUS_NAMES[e.apparatus]! : "" },
        { text: e.gymnast ?? "" },
        { text: e.text },
      ]),
    ];
    const title = group ? `Журнал изменений: ${AUDIT_GROUP_NAMES[group].toLowerCase()}` : "Журнал изменений";
    const content: Content[] = [
      entries.length === 0 ? { text: "Записей нет.", italics: true, margin: [0, 6, 0, 0] } : table(body, 4, { 1: 150, 3: 120 }),
    ];
    return renderPdf(this.document(competition, title, content));
  }

  async auditWorkbook(competitionId: string, group?: AuditGroup): Promise<Buffer> {
    const entries = (await this.audit.list(competitionId, group)).reverse();
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Журнал изменений");
    sheet.columns = [
      { header: "Время", key: "at", width: 20 },
      { header: "Раздел", key: "group", width: 18 },
      { header: "Кто", key: "actor", width: 40 },
      { header: "Снаряд", key: "apparatus", width: 22 },
      { header: "Участник", key: "gymnast", width: 30 },
      { header: "Что произошло", key: "text", width: 90 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    for (const e of entries) {
      sheet.addRow({
        at: auditTime(e.at),
        group: AUDIT_GROUP_NAMES[e.group],
        actor: e.actor,
        apparatus: e.apparatus ? APPARATUS_NAMES[e.apparatus] : "",
        gymnast: e.gymnast ?? "",
        text: e.text,
      });
    }
    return Buffer.from(await book.xlsx.writeBuffer());
  }

  /**
   * Нагрудные номера: по два на лист A4 (каждый — половина листа), крупный номер,
   * фамилия и имя, клуб и разряд. Не явившихся и снятых не печатаем.
   */
  async bibs(competitionId: string): Promise<Buffer> {
    const competition = await this.competitions.get(competitionId);
    const { people, categoryNames } = await this.roster(competitionId);
    const list = people.filter((g) => g.status === "ACTIVE").sort((a, b) => a.bib - b.bib);
    const card = (g: (typeof list)[number]): Content => ({
      stack: [
        ...(competition.logo ? [{ image: competition.logo, fit: [60, 60], alignment: "center" } as Content] : []),
        { text: competition.name, fontSize: 12, alignment: "center", color: "#555" },
        { text: String(g.bib), fontSize: 150, bold: true, alignment: "center", margin: [0, 6, 0, 0] },
        { text: `${g.lastName} ${g.firstName}`, fontSize: 22, bold: true, alignment: "center" },
        {
          text: [g.club, g.city, g.categoryId ? categoryNames.get(g.categoryId) : null].filter(Boolean).join(" · "),
          fontSize: 13,
          alignment: "center",
          color: "#444",
        },
      ],
    });
    // Каждый номер — в своей половине листа, на своём месте независимо от длины строк.
    const placed = (g: (typeof list)[number], half: number): Content => ({
      table: { widths: [535], body: [[card(g)]] },
      layout: "noBorders",
      absolutePosition: { x: 30, y: half === 0 ? 40 : 461 },
    });
    const content: Content[] =
      list.length === 0
        ? [{ text: "Участников пока нет." }]
        : list.flatMap((g, i) => [
            ...(i > 0 && i % 2 === 0 ? [{ text: "", pageBreak: "before" } as Content] : []),
            placed(g, i % 2),
          ]);
    return renderPdf({
      pageSize: "A4",
      pageOrientation: "portrait",
      pageMargins: [30, 30, 30, 30],
      info: { title: `${competition.name}. Нагрудные номера` },
      defaultStyle: { font: "Roboto" },
      // Линия отреза посередине листа.
      background: () => ({
        canvas: [{ type: "line", x1: 20, y1: 421, x2: 575, y2: 421, dash: { length: 4 }, lineWidth: 0.5, lineColor: "#999" }],
      }),
      content,
    });
  }

  /**
   * Итоговый отчёт для федерации или управления: участники по разрядам и клубам,
   * призёры, выполнившие разряды, судьи по категориям.
   */
  async report(competitionId: string): Promise<Buffer> {
    const competition = await this.competitions.get(competitionId);
    const { people, teamNames } = await this.roster(competitionId);
    const categoryList = await this.results.categoryList(competitionId);
    const judgeRows = await this.db.select().from(judges).where(eq(judges.competitionId, competitionId));
    const started = people.filter((g) => g.status !== "DNS");
    const content: Content[] = [];

    const count = (n: number) => String(n);
    content.push(
      { text: "Участники", style: "section" },
      table(
        [
          [th("Разряд"), th("Заявлено", "right"), th("Выступили", "right"), th("Неявка", "right"), th("Снятие", "right")],
          ...categoryList.map((c): TableCell[] => {
            const list = people.filter((g) => g.categoryId === c.id);
            return [
              c.name || "Все",
              { text: count(list.length), alignment: "right" },
              { text: count(list.filter((g) => g.status !== "DNS").length), alignment: "right" },
              { text: count(list.filter((g) => g.status === "DNS").length), alignment: "right" },
              { text: count(list.filter((g) => g.status === "WITHDRAWN").length), alignment: "right" },
            ];
          }),
          [
            { text: "Итого", bold: true },
            { text: count(people.length), alignment: "right", bold: true },
            { text: count(started.length), alignment: "right", bold: true },
            { text: count(people.filter((g) => g.status === "DNS").length), alignment: "right", bold: true },
            { text: count(people.filter((g) => g.status === "WITHDRAWN").length), alignment: "right", bold: true },
          ],
        ],
        0,
      ),
    );

    // Клубы и города: сколько выступило от каждого.
    const clubs = new Map<string, number>();
    for (const g of started) {
      const key = [g.club, g.city].filter(Boolean).join(", ") || (g.teamId ? (teamNames.get(g.teamId) ?? "") : "") || "Без клуба";
      clubs.set(key, (clubs.get(key) ?? 0) + 1);
    }
    content.push(
      { text: `Клубы и организации: ${clubs.size}`, style: "section" },
      table(
        [
          [th("Клуб, город"), th("Участников", "right")],
          ...[...clubs]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))
            .map(([name, n]): TableCell[] => [name, { text: count(n), alignment: "right" }]),
        ],
        0,
      ),
    );

    // Призёры многоборья и команд по разрядам.
    const medal: TableCell[][] = [[th("Разряд"), th("Зачёт"), th("Место"), th("Участник или команда"), th("Сумма", "right")]];
    let earnedTotal = 0;
    const earnedBy = new Map<string, number>();
    for (const c of categoryList) {
      const aa = await this.results.allAround(competitionId, c.id);
      for (const r of aa) {
        if (r.earned) {
          earnedTotal++;
          earnedBy.set(r.earned, (earnedBy.get(r.earned) ?? 0) + 1);
        }
        if (r.rank > 3 || !r.complete) continue;
        medal.push([c.name, "многоборье", String(r.rank), fullName(r.gymnast), { text: fmt(r.total), alignment: "right" }]);
      }
      const teams = await this.results.teams(competitionId, c.id).catch((e: unknown) => {
        if (e instanceof UnprocessableEntityException) return [];
        throw e;
      });
      for (const t of teams) {
        if (t.rank > 3) continue;
        medal.push([c.name, "команды", String(t.rank), t.team.name ?? "", { text: fmt(t.total), alignment: "right" }]);
      }
    }
    content.push({ text: "Призёры", style: "section" }, medal.length > 1 ? table(medal, 3) : emptyNote());

    if (earnedTotal > 0) {
      content.push(
        { text: `Выполнили спортивные разряды: ${earnedTotal}`, style: "section" },
        table(
          [[th("Разряд"), th("Человек", "right")], ...[...earnedBy].map(([name, n]): TableCell[] => [name, { text: count(n), alignment: "right" }])],
          0,
        ),
      );
    }

    // Судьи: одного человека в разных бригадах считаем один раз.
    const judgesByName = new Map<string, string>();
    for (const j of judgeRows) judgesByName.set(j.name.trim().toLowerCase(), j.category ?? "");
    for (const o of [competition.officials.chiefJudge, competition.officials.chiefSecretary]) {
      if (o) judgesByName.set(o.name.trim().toLowerCase(), o.category ?? "");
    }
    const byCategory = new Map<string, number>();
    for (const category of judgesByName.values()) {
      const key = category || "без категории";
      byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
    }
    content.push(
      { text: `Судьи: ${judgesByName.size}`, style: "section" },
      judgesByName.size === 0
        ? emptyNote()
        : table(
            [[th("Категория"), th("Человек", "right")], ...[...byCategory].map(([k, n]): TableCell[] => [k, { text: count(n), alignment: "right" }])],
            0,
          ),
    );
    return renderPdf(this.document(competition, "Итоговый отчёт", content));
  }

  /** Состав судейской коллегии: главные судья и секретарь, бригады по снарядам. */
  async officials(competitionId: string): Promise<Buffer> {
    const competition = await this.competitions.get(competitionId);
    const rows = await this.db
      .select()
      .from(judges)
      .where(eq(judges.competitionId, competitionId))
      .orderBy(asc(judges.seat));
    const order = { SUPERVISOR: 0, D: 1, E: 2 } as const;
    const line = (role: string, o: { name: string; category?: string | null; city?: string | null }): TableCell[] => [
      role,
      { text: o.name, bold: true },
      o.category ?? "",
      o.city ?? "",
    ];
    const head = (): TableCell[] => [th("Должность"), th("Фамилия, инициалы"), th("Категория"), th("Город")];
    const content: Content[] = [];
    const { chiefJudge, chiefSecretary } = competition.officials;
    if (chiefJudge || chiefSecretary) {
      content.push(
        { text: "Главная судейская коллегия", style: "section" },
        table(
          [
            head(),
            ...(chiefJudge ? [line("Главный судья", chiefJudge)] : []),
            ...(chiefSecretary ? [line("Главный секретарь", chiefSecretary)] : []),
          ],
          1,
        ),
      );
    }
    for (const apparatus of apparatusFor(competition.discipline)) {
      const panel = rows
        .filter((j) => j.apparatus === apparatus)
        .sort((a, b) => order[a.role] - order[b.role] || a.seat - b.seat);
      if (panel.length === 0) continue;
      content.push(
        { text: APPARATUS_NAMES[apparatus]!, style: "section" },
        table(
          [
            head(),
            ...panel.map((j) =>
              line(j.role === "SUPERVISOR" ? "Старший судья" : `Судья ${j.role}${j.seat}`, j),
            ),
          ],
          1,
        ),
      );
    }
    if (content.length === 0) {
      content.push({ text: "Судьи ещё не заведены.", style: "note" });
    }
    return renderPdf(this.document(competition, "Состав судейской коллегии", content));
  }

  /**
   * Выполнившие разряды — список для приказа о присвоении: по уровням,
   * с датой рождения, клубом, городом и тренером.
   */
  async earned(competitionId: string): Promise<Buffer> {
    const competition = await this.competitions.get(competitionId);
    const { people, categoryNames } = await this.roster(competitionId);
    const byId = new Map(people.map((g) => [g.id, g]));
    const rows = (await this.results.allAround(competitionId)).filter((r) => r.earned);
    const levels = [...new Set(rows.map((r) => r.earned!))];
    const content: Content[] = [];
    for (const level of levels) {
      const list = rows
        .filter((r) => r.earned === level)
        .map((r) => ({ row: r, g: byId.get(r.gymnast.id)! }))
        .sort((a, b) => a.g.lastName.localeCompare(b.g.lastName, "ru") || a.g.firstName.localeCompare(b.g.firstName, "ru"));
      content.push(
        { text: `${level} — ${list.length} чел.`, style: "section" },
        table([
          [th("п/п"), th("Фамилия, имя, отчество"), th("Дата рожд."), th("Клуб, город"), th("Тренер"), th("Разряд соревнований"), th("Сумма", "right")],
          ...list.map(({ row, g }, i): TableCell[] => [
            String(i + 1),
            { text: [g.lastName, g.firstName, g.middleName].filter(Boolean).join(" "), bold: true },
            g.birthDate ?? "",
            [g.club, g.city].filter(Boolean).join(", "),
            g.coach ?? "",
            g.categoryId ? (categoryNames.get(g.categoryId) ?? "") : "",
            { text: fmt(row.total), alignment: "right" },
          ]),
        ], 1),
      );
    }
    if (content.length === 0) {
      content.push({
        text: "Никто пока не выполнил разряд. Проверьте, что нормативы заданы и многоборье пройдено на всех снарядах.",
        style: "note",
      });
    }
    return renderPdf(this.document(competition, "Выполнили спортивные разряды", content));
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
    stage: Stage,
  ) {
    const perfs = await this.db
      .select()
      .from(performances)
      .where(
        and(
          eq(performances.competitionId, competitionId),
          eq(performances.apparatus, apparatus),
          eq(performances.status, "APPROVED"),
          eq(performances.stage, stage),
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

  /**
   * Грамоты призёрам по разрядам: многоборье и команды или отдельные снаряды.
   * При дележе места грамоту получают все, кто его разделил.
   */
  async diplomas(
    competitionId: string,
    kind: "all-around" | "apparatus",
    places: number,
  ): Promise<Buffer> {
    const competition = await this.competitions.get(competitionId);
    const teamNames = await this.teamNames(competitionId);
    const from = (g: GymnastView) =>
      [...new Set([g.club, g.teamId ? teamNames.get(g.teamId) : undefined].filter(Boolean))].join(" · ") ||
      undefined;
    const list: Diploma[] = [];
    for (const c of await this.results.categoryList(competitionId)) {
      const category = c.name || undefined;
      if (kind === "all-around") {
        for (const r of await this.results.allAround(competitionId, c.id)) {
          if (r.rank > places || !r.complete) continue;
          list.push({ who: fullName(r.gymnast), from: from(r.gymnast), place: r.rank, event: "в многоборье", category, team: false });
        }
        const teams = await this.results.teams(competitionId, c.id).catch((e: unknown) => {
          if (e instanceof UnprocessableEntityException) return [];
          throw e;
        });
        for (const t of teams) {
          if (t.rank > places) continue;
          list.push({ who: t.team.name ?? "", place: t.rank, event: "в командном зачёте", category, team: true });
        }
      } else {
        for (const code of apparatusFor(competition.discipline)) {
          // Если на снаряде был финал, медали разыгрывались в нём.
          const final = await this.results.apparatus(competitionId, code, "average", c.id, "FINAL");
          const rows = final.length > 0 ? final : await this.results.apparatus(competitionId, code, "average", c.id);
          for (const r of rows) {
            if (r.rank > places) continue;
            list.push({ who: fullName(r.gymnast), from: from(r.gymnast), place: r.rank, event: APPARATUS_EVENT[code]!, category, team: false });
          }
        }
      }
    }
    return renderPdf(diplomasDocument(competition, list));
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
        finals: await Promise.all(
          program.map(async (code) => ({
            code,
            rows: await this.results.apparatus(competitionId, code, "average", c.id, "FINAL"),
          })),
        ),
      })),
    );
    return resultsWorkbook(
      competition.name,
      program,
      categories,
      await this.teamNames(competitionId),
      competition.rules,
      (await this.results.clubs(competitionId)).rows,
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
      g.status === "ACTIVE"
        ? { text: `${g.lastName} ${g.firstName}`, bold: true }
        : {
            text: [
              { text: `${g.lastName} ${g.firstName}`, bold: true, decoration: "lineThrough" },
              ` — ${GYMNAST_STATUS_NAMES[g.status]}`,
            ],
            color: "#777",
          },
      birthYear(g.birthDate),
      {
        stack: [
          [g.club, g.city].filter(Boolean).join(", "),
          ...(g.coach ? [{ text: `тренер ${g.coach}`, style: "small" }] : []),
        ],
      },
      g.teamId ? (teamNames.get(g.teamId) ?? "") : "",
      g.categoryId ? (categoryNames.get(g.categoryId) ?? "") : "",
    ];
    const header = (): TableCell[] => [
      th("п/п"),
      th("№"),
      th("Участник"),
      th("Г.р."),
      th("Клуб, город"),
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
    stage: Stage = "QUAL",
  ): Promise<Buffer> {
    const competition = await this.competitions.get(competitionId);
    if (!apparatusFor(competition.discipline).includes(apparatus)) {
      throw new UnprocessableEntityException(
        `Снаряда ${apparatus} нет в программе ${competition.discipline}`,
      );
    }
    const roster = await this.roster(competitionId);
    const { shiftRows, categoryNames } = roster;
    // Не явившихся и снявшихся в ведомости не пишем.
    const people = roster.people.filter((g) => g.status === "ACTIVE");
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
      th(competition.rules === "CUSTOM" ? "Треб." : "D", "right"),
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
    // По своим правилам в ведомости видна база разряда на этом снаряде.
    const bases =
      competition.rules === "CUSTOM"
        ? new Map(
            (
              await this.db
                .select()
                .from(categories)
                .where(eq(categories.competitionId, competitionId))
            ).map((c) => [c.id, c.apparatusBase[apparatus] ?? c.base]),
          )
        : new Map<string, number | null>();
    const baseNote = (categoryId: string) => {
      const base = bases.get(categoryId);
      return base === null || base === undefined
        ? ""
        : ` · база ${fmt(fromPoints(base))}`;
    };
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
                        text:
                          (categoryNames.get(g.categoryId) ?? "") +
                          baseNote(g.categoryId),
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
    if (stage === "FINAL") {
      // Финал: по разрядам финалисты в порядке жеребьёвки, ниже запасные.
      const byId = new Map(people.map((g) => [g.id, g]));
      const lists = (await this.finals.view(competitionId)).lists.filter((l) => l.apparatus === apparatus);
      for (const l of lists) {
        const members = l.finalists.filter((f) => !f.reserve && byId.has(f.gymnast.id));
        if (l.category.name) content.push({ text: l.category.name, style: "section" });
        content.push(sheet(members.map((f) => byId.get(f.gymnast.id)!)));
        const reserves = l.finalists.filter((f) => f.reserve);
        if (reserves.length > 0) {
          content.push({
            text: `Запасные: ${reserves.map((f) => `${f.position}. №${f.gymnast.bib} ${f.gymnast.lastName} ${f.gymnast.firstName}`).join("; ")}`,
            style: "note",
          });
        }
      }
      if (content.length === 0) content.push(emptyList());
    } else if (shiftRows.length > 0) {
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
    content.push({
      text:
        competition.rules === "CUSTOM"
          ? "Треб. — сбавки за невыполненные требования программы. НС — нейтральная сбавка. Итог = база − Треб. − средняя сбавка E − НС."
          : "НС — нейтральная сбавка.",
      style: "note",
    });
    return renderPdf(
      this.document(
        competition,
        `${stage === "FINAL" ? "Финал, судейская ведомость" : "Судейская ведомость"}: ${APPARATUS_NAMES[apparatus]}`,
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
      officials?: { chiefJudge: Official | null; chiefSecretary: Official | null };
    },
    title: string,
    content: Content[],
  ): TDocumentDefinitions {
    const sign = (role: string, o: Official | null | undefined) =>
      `${role} ______________________${o ? ` ${officialLabel(o)}` : ""}`;
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
            { text: sign("Главный судья", competition.officials?.chiefJudge) },
            { text: sign("Главный секретарь", competition.officials?.chiefSecretary) },
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

/** «20.10.2026, 14:05:31» — до секунд: жюри важен порядок действий. */
export const auditTime = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

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
