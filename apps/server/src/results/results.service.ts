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
import type { LiveApparatus } from "@ag/shared";
import { and, asc, eq } from "drizzle-orm";
import { CompetitionsService } from "../competitions/competitions.service";
import { DB, type Db } from "../db/db.module";
import { gymnasts, judges, marks, performances, teams } from "../db/schema";

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
});

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

  async apparatus(competitionId: string, apparatus: Apparatus, vaultMode: VaultMode = "average") {
    const competition = await this.competitions.get(competitionId);
    if (!apparatusFor(competition.discipline).includes(apparatus)) {
      throw new UnprocessableEntityException(`Снаряда ${apparatus} нет в программе ${competition.discipline}`);
    }
    const [scores, people] = await Promise.all([
      this.approvedScores(competitionId),
      this.gymnastsById(competitionId),
    ]);
    const entries = [...scores].flatMap(([gymnastId, byApparatus]) => {
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

  async allAround(competitionId: string) {
    const competition = await this.competitions.get(competitionId);
    const [scores, people] = await Promise.all([
      this.approvedScores(competitionId),
      this.gymnastsById(competitionId),
    ]);
    const entries = [...scores].map(([gymnastId, byApparatus]) => ({
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

  async teams(competitionId: string) {
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
    const entries = teamRows.map((team) => ({
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
}
