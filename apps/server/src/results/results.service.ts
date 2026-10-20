import { Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import {
  apparatusFor,
  averageVaults,
  fromPoints,
  rankAllAround,
  rankApparatus,
  rankTeams,
  type Apparatus,
  type ScoreBreakdown,
} from "@ag/scoring";
import type { BoardSnapshot, CategoryResults, LiveApparatus } from "@ag/shared";
import { and, asc, eq, isNull } from "drizzle-orm";
import { CompetitionsService } from "../competitions/competitions.service";
import { DB, type Db } from "../db/db.module";
import { categories, gymnasts, judges, marks, performances, teams } from "../db/schema";

type GymnastRow = typeof gymnasts.$inferSelect;

export type VaultMode = "first" | "average";

const toView = (s: ScoreBreakdown) => ({
  d: fromPoints(s.d),
  e: fromPoints(s.e),
  neutral: fromPoints(s.neutral),
  total: fromPoints(s.total),
});

const gymnastView = (g: GymnastRow) => ({
  id: g.id,
  bib: g.bib,
  firstName: g.firstName,
  lastName: g.lastName,
  club: g.club,
  teamId: g.teamId,
  categoryId: g.categoryId,
});

/**
 * Какие участники попадают в таблицу: undefined — все, строка — один разряд,
 * null — участники без разряда.
 */
export type CategoryScope = string | null | undefined;

const inScope = (scope: CategoryScope, categoryId: string | null) => scope === undefined || categoryId === scope;

@Injectable()
export class ResultsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly competitions: CompetitionsService,
  ) {}

  /** Утверждённые оценки: участник → снаряд → попытка → оценка. */
  private async approvedScores(competitionId: string) {
    const rows = await this.db
      .select()
      .from(performances)
      .where(and(eq(performances.competitionId, competitionId), eq(performances.status, "APPROVED")));
    const byGymnast = new Map<string, Map<Apparatus, Map<number, ScoreBreakdown>>>();
    for (const r of rows) {
      if (r.total === null) continue;
      const apparatus = byGymnast.get(r.gymnastId) ?? new Map();
      byGymnast.set(r.gymnastId, apparatus);
      const attempts = apparatus.get(r.apparatus) ?? new Map();
      apparatus.set(r.apparatus, attempts);
      attempts.set(r.attempt, { d: r.d ?? 0, e: r.e ?? 0, neutral: r.neutral ?? 0, total: r.total });
    }
    return byGymnast;
  }

  private async gymnastsById(competitionId: string) {
    const rows = await this.db.select().from(gymnasts).where(eq(gymnasts.competitionId, competitionId));
    return new Map(rows.map((g) => [g.id, g]));
  }

  /**
   * Оценка участника за снаряд. Для опорного прыжка в режиме "average"
   * берётся среднее двух попыток, если обе утверждены.
   */
  private static pick(attempts: Map<number, ScoreBreakdown>, mode: VaultMode): ScoreBreakdown | undefined {
    const first = attempts.get(1);
    const second = attempts.get(2);
    if (mode === "average" && first && second) return averageVaults(first, second);
    return first;
  }

  /** Для табло: на каждом снаряде кто выступает сейчас и последняя утверждённая оценка. */
  async live(competitionId: string): Promise<LiveApparatus[]> {
    const competition = await this.competitions.get(competitionId);
    const [rows, people] = await Promise.all([
      this.db
        .select()
        .from(performances)
        .where(eq(performances.competitionId, competitionId))
        .orderBy(asc(performances.createdAt)),
      this.gymnastsById(competitionId),
    ]);
    const result: LiveApparatus[] = [];
    for (const apparatus of apparatusFor(competition.discipline)) {
      const onApparatus = rows.filter((r) => r.apparatus === apparatus);
      const current = [...onApparatus].reverse().find((r) => r.status === "SCORING");
      const last = onApparatus
        .filter((r) => r.status === "APPROVED" && r.approvedAt && r.total !== null)
        .sort((a, b) => a.approvedAt!.getTime() - b.approvedAt!.getTime())
        .at(-1);
      let eMarks: number[] | null = null;
      if (last && competition.publishJudgeMarks) {
        const markRows = await this.db
          .select({ value: marks.value })
          .from(marks)
          .innerJoin(judges, eq(judges.id, marks.judgeId))
          .where(and(eq(marks.performanceId, last.id), eq(marks.kind, "E")))
          .orderBy(asc(judges.seat));
        eMarks = markRows.map((m) => fromPoints(m.value));
      }
      result.push({
        apparatus,
        current: current
          ? { performanceId: current.id, attempt: current.attempt, gymnast: gymnastView(people.get(current.gymnastId)!) }
          : null,
        last: last
          ? {
              performanceId: last.id,
              attempt: last.attempt,
              gymnast: gymnastView(people.get(last.gymnastId)!),
              score: toView({ d: last.d ?? 0, e: last.e ?? 0, neutral: last.neutral ?? 0, total: last.total! }),
              approvedAt: last.approvedAt!.toISOString(),
              eMarks,
            }
          : null,
      });
    }
    return result;
  }

  async apparatus(
    competitionId: string,
    apparatus: Apparatus,
    vaultMode: VaultMode = "average",
    scope: CategoryScope = undefined,
  ) {
    const competition = await this.competitions.get(competitionId);
    if (!apparatusFor(competition.discipline).includes(apparatus)) {
      throw new UnprocessableEntityException(`Снаряда ${apparatus} нет в программе ${competition.discipline}`);
    }
    const [scores, people] = await Promise.all([
      this.approvedScores(competitionId),
      this.gymnastsById(competitionId),
    ]);
    const entries = [...scores].flatMap(([gymnastId, byApparatus]) => {
      if (!inScope(scope, people.get(gymnastId)!.categoryId)) return [];
      const attempts = byApparatus.get(apparatus);
      const score = attempts && ResultsService.pick(attempts, apparatus === "VT" ? vaultMode : "first");
      return score ? [{ id: gymnastId, score }] : [];
    });
    return rankApparatus(entries).map(({ rank, item }) => ({
      rank,
      gymnast: gymnastView(people.get(item.id)!),
      score: toView(item.score),
    }));
  }

  async allAround(competitionId: string, scope: CategoryScope = undefined) {
    const competition = await this.competitions.get(competitionId);
    const [scores, people] = await Promise.all([
      this.approvedScores(competitionId),
      this.gymnastsById(competitionId),
    ]);
    const entries = [...scores]
      .filter(([gymnastId]) => inScope(scope, people.get(gymnastId)!.categoryId))
      .map(([gymnastId, byApparatus]) => ({
      id: gymnastId,
      scores: Object.fromEntries(
        [...byApparatus].map(([a, attempts]) => [a, ResultsService.pick(attempts, "first")]),
      ) as Partial<Record<Apparatus, ScoreBreakdown>>,
    }));
    const byId = new Map(entries.map((e) => [e.id, e]));
    return rankAllAround(competition.discipline, entries).map(({ rank, item }) => ({
      rank,
      gymnast: gymnastView(people.get(item.id)!),
      total: fromPoints(item.total),
      complete: item.complete,
      apparatus: Object.fromEntries(
        Object.entries(byId.get(item.id)!.scores).map(([a, s]) => [a, toView(s)]),
      ),
    }));
  }

  async teams(competitionId: string, scope: CategoryScope = undefined) {
    const competition = await this.competitions.get(competitionId);
    const [scores, people, teamRows] = await Promise.all([
      this.approvedScores(competitionId),
      this.gymnastsById(competitionId),
      this.db.select().from(teams).where(eq(teams.competitionId, competitionId)),
    ]);
    const format = {
      roster: competition.teamRoster,
      perApparatus: competition.teamPerApparatus,
      counting: competition.teamCounting,
    };
    const entries = teamRows.filter((team) => inScope(scope, team.categoryId)).map((team) => ({
      id: team.id,
      members: [...people.values()]
        .filter((g) => g.teamId === team.id)
        .map((g) => ({
          id: g.id,
          scores: Object.fromEntries(
            [...(scores.get(g.id) ?? new Map<Apparatus, Map<number, ScoreBreakdown>>())].map(
              ([a, attempts]) => [a, ResultsService.pick(attempts, "first")],
            ),
          ) as Partial<Record<Apparatus, ScoreBreakdown>>,
        })),
    }));
    const names = new Map(teamRows.map((t) => [t.id, t.name]));
    let ranked;
    try {
      ranked = rankTeams(competition.discipline, format, entries);
    } catch (e) {
      if (e instanceof RangeError) throw new UnprocessableEntityException(e.message);
      throw e;
    }
    return ranked.map(({ rank, item }) => ({
      rank,
      team: { id: item.id, name: names.get(item.id) },
      total: fromPoints(item.total),
      apparatus: item.byApparatus.map((a) => ({
        apparatus: a.apparatus,
        total: fromPoints(a.total),
        counted: a.counted,
      })),
    }));
  }

  /**
   * Разряды соревнования для таблиц. Без разрядов — одна общая запись (id null).
   * Участники без разряда при заданных разрядах идут отдельной записью.
   */
  async categoryList(competitionId: string): Promise<{ id: string | null; name: string }[]> {
    const [rows, unassigned] = await Promise.all([
      this.db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(eq(categories.competitionId, competitionId))
        .orderBy(asc(categories.position)),
      this.db
        .select({ id: gymnasts.id })
        .from(gymnasts)
        .where(and(eq(gymnasts.competitionId, competitionId), isNull(gymnasts.categoryId)))
        .limit(1),
    ]);
    if (rows.length === 0) return [{ id: null, name: "" }];
    return unassigned.length > 0 ? [...rows, { id: null, name: "Без разряда" }] : rows;
  }

  private async categoryResults(
    competitionId: string,
    category: { id: string | null; name: string },
    apparatusList: Apparatus[],
  ): Promise<CategoryResults> {
    const [allAround, teams, apparatus] = await Promise.all([
      this.allAround(competitionId, category.id),
      this.teams(competitionId, category.id).catch((e: unknown) => {
        if (e instanceof UnprocessableEntityException) return [];
        throw e;
      }),
      Promise.all(apparatusList.map((a) => this.apparatus(competitionId, a, "average", category.id))),
    ]);
    return {
      ...category,
      allAround,
      teams,
      apparatus: Object.fromEntries(apparatusList.map((a, i) => [a, apparatus[i]!])),
    };
  }

  /** Снимок для табло и сайта: все таблицы одним ответом. */
  async snapshot(competitionId: string): Promise<BoardSnapshot> {
    const competition = await this.competitions.get(competitionId);
    const [live, categoryList] = await Promise.all([this.live(competitionId), this.categoryList(competitionId)]);
    const apparatusList = live.map((a) => a.apparatus);
    const results = await Promise.all(
      categoryList.map((c) => this.categoryResults(competitionId, c, apparatusList)),
    );
    return {
      competition: {
        id: competition.id,
        name: competition.name,
        discipline: competition.discipline,
        rules: competition.rules,
      },
      live,
      categories: results,
      generatedAt: new Date().toISOString(),
    };
  }
}
