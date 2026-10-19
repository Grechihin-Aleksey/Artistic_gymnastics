import { Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { apparatusFor, defaultDrop, fromPoints, type Apparatus } from "@ag/scoring";
import { APPARATUS_NAMES, type GymnastView } from "@ag/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { CompetitionsService } from "../competitions/competitions.service";
import { DB, type Db } from "../db/db.module";
import { inquiries, judges, marks, performances, teams } from "../db/schema";
import { ResultsService } from "../results/results.service";
import { renderPdf } from "./pdf";

const DISCIPLINE_NAMES = { MAG: "мужчины", WAG: "женщины" } as const;
const fmt = (n: number) => n.toFixed(3);
const fullName = (g: GymnastView) => `${g.lastName} ${g.firstName}`;

/**
 * Какие сбавки судей E отброшены как крайние (по FIG: по 2 при 7 судьях и больше,
 * по 1 при 4–6). При равных значениях отбрасывается первое по порядку мест.
 */
export function droppedDeductions(values: readonly number[]): boolean[] {
  const drop = defaultDrop(values.length);
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
  const dropped = new Array<boolean>(values.length).fill(false);
  for (const { i } of [...order.slice(0, drop), ...order.slice(order.length - drop)]) dropped[i] = true;
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

  async apparatus(competitionId: string, apparatus: Apparatus): Promise<Buffer> {
    const competition = await this.competitions.get(competitionId);
    const rows = await this.results.apparatus(competitionId, apparatus, "average");
    const eSeats = (
      await this.db
        .select({ seat: judges.seat })
        .from(judges)
        .where(and(eq(judges.competitionId, competitionId), eq(judges.apparatus, apparatus), eq(judges.role, "E")))
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
        const dropped = droppedDeductions(a.eMarks.filter((m): m is number => m !== null));
        let k = 0;
        const eCells = a.eMarks.map((m): TableCell => {
          if (m === null) return { text: "—", alignment: "right" };
          const isDropped = dropped[k++];
          return { text: isDropped ? `(${fmt(m)})` : fmt(m), alignment: "right", color: isDropped ? "#777" : undefined };
        });
        if (a.dChanged) changedNote = true;
        body.push([
          first ? { text: String(row.rank), bold: true, rowSpan: span } : {},
          first ? { text: String(row.gymnast.bib), rowSpan: span } : {},
          first ? { stack: gymnastStack(row.gymnast, teamNames), rowSpan: span } : {},
          ...(isVault ? [{ text: String(a.attempt), alignment: "center" } as TableCell] : []),
          { text: fmt(a.d) + (a.dChanged ? " *" : ""), alignment: "right" },
          ...eCells,
          { text: fmt(a.e), alignment: "right" },
          { text: a.neutral > 0 ? `−${fmt(a.neutral)}` : "", alignment: "right" },
          { text: fmt(a.total), alignment: "right", bold: !isVault },
          ...(isVault
            ? [first ? ({ text: fmt(row.score.total), alignment: "right", bold: true, rowSpan: span } as TableCell) : {}]
            : []),
        ]);
      });
    }

    const notes: string[] = ["В скобках — крайние сбавки судей E, не вошедшие в среднее."];
    if (isVault) notes.push("Итог опорного прыжка — среднее двух прыжков.");
    if (changedNote) notes.push("* Оценка D изменена апелляционным жюри по запросу тренера.");
    return renderPdf(
      this.document(competition, `Протокол: ${APPARATUS_NAMES[apparatus]}`, [
        rows.length === 0 ? emptyNote() : table(body),
        ...notes.map((n) => ({ text: n, style: "note" }) as Content),
      ]),
    );
  }

  async allAround(competitionId: string): Promise<Buffer> {
    const competition = await this.competitions.get(competitionId);
    const rows = await this.results.allAround(competitionId);
    const program = apparatusFor(competition.discipline);
    const teamNames = await this.teamNames(competitionId);
    const body: TableCell[][] = [
      [th("Место"), th("№"), th("Участник"), ...program.map((a) => th(APPARATUS_NAMES[a]!, "right")), th("Сумма", "right")],
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
              { text: `D ${fmt(s.d)} · E ${fmt(s.e)}${s.neutral > 0 ? ` · −${fmt(s.neutral)}` : ""}`, style: "small", alignment: "right" },
            ],
          };
        }),
        { text: fmt(row.total) + (row.complete ? "" : " ¹"), alignment: "right", bold: true },
      ]);
    }
    const notes = ["Опорный прыжок в многоборье — оценка за первый прыжок."];
    if (rows.some((r) => !r.complete)) notes.push("¹ Выступил(а) не на всех снарядах.");
    return renderPdf(
      this.document(competition, "Протокол: личное многоборье", [
        rows.length === 0 ? emptyNote() : table(body),
        ...notes.map((n) => ({ text: n, style: "note" }) as Content),
      ]),
    );
  }

  async teams(competitionId: string): Promise<Buffer> {
    const competition = await this.competitions.get(competitionId);
    const program = apparatusFor(competition.discipline);
    let ranked;
    try {
      ranked = await this.results.teams(competitionId);
    } catch (e) {
      if (e instanceof UnprocessableEntityException) {
        throw new UnprocessableEntityException(`Командный протокол не собрать: ${e.message}`);
      }
      throw e;
    }
    const people = await this.results.allAround(competitionId);
    const body: TableCell[][] = [
      [th("Место"), th("Команда / участник"), ...program.map((a) => th(APPARATUS_NAMES[a]!, "right")), th("Сумма", "right")],
    ];
    for (const team of ranked) {
      body.push([
        { text: String(team.rank), bold: true },
        { text: team.team.name ?? "", bold: true },
        ...program.map((a): TableCell => {
          const t = team.apparatus.find((x) => x.apparatus === a);
          return { text: t ? fmt(t.total) : "—", alignment: "right", bold: true };
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
            const counted = team.apparatus.find((x) => x.apparatus === a)?.counted.includes(m.gymnast.id);
            return { text: counted ? fmt(s.total) : `(${fmt(s.total)})`, alignment: "right", style: "member", color: counted ? undefined : "#777" };
          }),
          "",
        ]);
      }
    }
    const format = `${competition.teamRoster}-${competition.teamPerApparatus}-${competition.teamCounting}`;
    return renderPdf(
      this.document(competition, "Протокол: командное первенство", [
        ranked.length === 0 ? emptyNote() : table(body, 1),
        { text: `Формат ${format}: в составе до ${competition.teamRoster}, на снаряде выступают до ${competition.teamPerApparatus}, в зачёт идут ${competition.teamCounting} лучших оценки.`, style: "note" },
        { text: "В скобках — оценки, не вошедшие в зачёт команды.", style: "note" },
      ]),
    );
  }

  /** Утверждённые выступления на снаряде с оценками каждого судьи E. */
  private async attempts(competitionId: string, apparatus: Apparatus, eSeats: number[]) {
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
            .select({ performanceId: marks.performanceId, value: marks.value, seat: judges.seat })
            .from(marks)
            .innerJoin(judges, eq(judges.id, marks.judgeId))
            .where(and(inArray(marks.performanceId, ids), eq(marks.kind, "E"))),
          this.db
            .select({ performanceId: inquiries.performanceId })
            .from(inquiries)
            .where(and(inArray(inquiries.performanceId, ids), eq(inquiries.status, "ACCEPTED"))),
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

  private async teamNames(competitionId: string) {
    const rows = await this.db.select().from(teams).where(eq(teams.competitionId, competitionId));
    return new Map(rows.map((t) => [t.id, t.name]));
  }

  private document(
    competition: { name: string; discipline: keyof typeof DISCIPLINE_NAMES },
    title: string,
    content: Content[],
  ): TDocumentDefinitions {
    const printed = new Date().toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" });
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
      },
      content: [
        { text: competition.name, style: "competition" },
        { text: `${title} · ${DISCIPLINE_NAMES[competition.discipline]}`, style: "title" },
        { text: `Сформирован ${printed}`, style: "meta" },
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

function gymnastStack(g: GymnastView, teamNames?: Map<string, string>): Content[] {
  const club = [g.club, g.teamId ? teamNames?.get(g.teamId) : undefined].filter(Boolean);
  const unique = [...new Set(club)].join(" · ");
  return [{ text: fullName(g), bold: true }, ...(unique ? [{ text: unique, style: "small" }] : [])];
}

/** nameIndex — колонка с именем: она тянется на свободное место, остальные по содержимому. */
function table(body: TableCell[][], nameIndex = 2): Content {
  return {
    table: {
      headerRows: 1,
      dontBreakRows: true,
      widths: body[0]!.map((_, i) => (i === nameIndex ? "*" : "auto")),
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

function emptyNote(): Content {
  return { text: "Утверждённых оценок пока нет.", italics: true, margin: [0, 10, 0, 0] };
}
