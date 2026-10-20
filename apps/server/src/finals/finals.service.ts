import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomInt } from "node:crypto";
import { apparatusFor, fromPoints, toPoints, type Apparatus } from "@ag/scoring";
import {
  LIVE_EVENTS,
  type CreateFinalsInput,
  type FinalsView,
  type ReplaceFinalistInput,
  type SetPhaseInput,
} from "@ag/shared";
import { and, asc, eq } from "drizzle-orm";
import { CompetitionsService } from "../competitions/competitions.service";
import { DB, type Db } from "../db/db.module";
import { auditLog, competitions, finalists, gymnasts, performances } from "../db/schema";
import { LiveGateway } from "../live/live.gateway";
import { ResultsService } from "../results/results.service";

type FinalistRow = typeof finalists.$inferInsert;

/**
 * Финалы на отдельных снарядах: отбор по квалификации в каждом разряде,
 * жеребьёвка порядка выступления, запасные и переключение этапа.
 */
@Injectable()
export class FinalsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly competitions: CompetitionsService,
    private readonly results: ResultsService,
    private readonly live: LiveGateway,
  ) {}

  async view(competitionId: string): Promise<FinalsView> {
    const competition = await this.competitions.get(competitionId);
    const [rows, people, categoryList, started] = await Promise.all([
      this.db
        .select()
        .from(finalists)
        .where(eq(finalists.competitionId, competitionId))
        .orderBy(asc(finalists.reserve), asc(finalists.position)),
      this.db.select().from(gymnasts).where(eq(gymnasts.competitionId, competitionId)),
      this.results.categoryList(competitionId),
      this.started(competitionId),
    ]);
    const byId = new Map(people.map((g) => [g.id, g]));
    const lists: FinalsView["lists"] = [];
    for (const apparatus of apparatusFor(competition.discipline)) {
      for (const category of categoryList) {
        const list = rows.filter((r) => r.apparatus === apparatus && r.categoryId === category.id);
        if (list.length === 0) continue;
        lists.push({
          apparatus,
          category,
          finalists: list.map((r) => {
            const g = byId.get(r.gymnastId)!;
            return {
              gymnast: {
                id: g.id,
                bib: g.bib,
                firstName: g.firstName,
                lastName: g.lastName,
                club: g.club,
                teamId: g.teamId,
                categoryId: g.categoryId,
              },
              position: r.position,
              reserve: r.reserve,
              qualRank: r.qualRank,
              qualTotal: fromPoints(r.qualTotal),
            };
          }),
        });
      }
    }
    return {
      phase: competition.phase,
      size: competition.finalSize,
      reserves: competition.finalReserves,
      perClub: competition.finalPerClub,
      started,
      lists,
    };
  }

  /**
   * Состав финалов по утверждённым оценкам квалификации. Пересобрать можно,
   * пока в финалах нет ни одного выступления.
   */
  async create(competitionId: string, input: CreateFinalsInput): Promise<FinalsView> {
    const competition = await this.competitions.get(competitionId);
    if (await this.started(competitionId)) {
      throw new ConflictException("В финалах уже есть выступления: состав не пересобрать");
    }
    const [categoryList, people] = await Promise.all([
      this.results.categoryList(competitionId),
      this.db.select().from(gymnasts).where(eq(gymnasts.competitionId, competitionId)),
    ]);
    const active = new Set(people.filter((g) => g.status === "ACTIVE").map((g) => g.id));
    const rows: FinalistRow[] = [];
    for (const apparatus of apparatusFor(competition.discipline)) {
      for (const category of categoryList) {
        const ranking = await this.results.apparatus(competitionId, apparatus, "average", category.id, "QUAL");
        rows.push(...selectFinalists(competitionId, apparatus, category.id, ranking, active, input));
      }
    }
    if (rows.length === 0) {
      throw new ConflictException("Нет утверждённых оценок квалификации: отбирать в финалы некого");
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(finalists).where(eq(finalists.competitionId, competitionId));
      await tx.insert(finalists).values(rows);
      await tx
        .update(competitions)
        .set({ finalSize: input.size, finalReserves: input.reserves, finalPerClub: input.perClub })
        .where(eq(competitions.id, competitionId));
      await tx.insert(auditLog).values({
        competitionId,
        actor: "admin",
        action: "finals.created",
        details: { ...input, finalists: rows.map((r) => ({ apparatus: r.apparatus, gymnastId: r.gymnastId, reserve: r.reserve })) },
      });
    });
    return this.changed(competitionId);
  }

  async setPhase(competitionId: string, input: SetPhaseInput): Promise<FinalsView> {
    await this.competitions.get(competitionId);
    if (input.phase === "FINAL") {
      const [any] = await this.db
        .select({ id: finalists.id })
        .from(finalists)
        .where(eq(finalists.competitionId, competitionId))
        .limit(1);
      if (!any) throw new ConflictException("Сначала сформируйте финалы");
    }
    const [open] = await this.db
      .select({ id: performances.id })
      .from(performances)
      .where(and(eq(performances.competitionId, competitionId), eq(performances.status, "SCORING")))
      .limit(1);
    if (open) throw new ConflictException("Есть неутверждённое выступление: сначала утвердите оценку");
    await this.db.update(competitions).set({ phase: input.phase }).where(eq(competitions.id, competitionId));
    await this.db.insert(auditLog).values({ competitionId, actor: "admin", action: "finals.phase", details: input });
    return this.changed(competitionId);
  }

  /** Финалист снимается: первый запасной разряда встаёт на его место в порядке выступления. */
  async replace(competitionId: string, apparatus: Apparatus, input: ReplaceFinalistInput): Promise<FinalsView> {
    await this.competitions.get(competitionId);
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(finalists)
        .where(
          and(
            eq(finalists.competitionId, competitionId),
            eq(finalists.apparatus, apparatus),
            eq(finalists.gymnastId, input.gymnastId),
          ),
        );
      if (!row) throw new NotFoundException("Участника нет в финале на этом снаряде");
      if (row.reserve) throw new BadRequestException("Это запасной, заменять некого");
      const [performed] = await tx
        .select({ id: performances.id })
        .from(performances)
        .where(
          and(
            eq(performances.gymnastId, input.gymnastId),
            eq(performances.apparatus, apparatus),
            eq(performances.stage, "FINAL"),
          ),
        )
        .limit(1);
      if (performed) throw new ConflictException("Финалист уже выступил: заменить нельзя");
      const reserves = await tx
        .select()
        .from(finalists)
        .innerJoin(gymnasts, eq(gymnasts.id, finalists.gymnastId))
        .where(
          and(
            eq(finalists.competitionId, competitionId),
            eq(finalists.apparatus, apparatus),
            eq(finalists.reserve, true),
            eq(gymnasts.status, "ACTIVE"),
          ),
        )
        .orderBy(asc(finalists.position));
      const next = reserves.find((r) => r.finalists.categoryId === row.categoryId)?.finalists;
      if (!next) throw new ConflictException("Запасных в этом разряде не осталось");
      await tx.delete(finalists).where(eq(finalists.id, row.id));
      await tx.update(finalists).set({ reserve: false, position: row.position }).where(eq(finalists.id, next.id));
      await tx.insert(auditLog).values({
        competitionId,
        actor: "admin",
        action: "finals.replaced",
        details: { apparatus, out: row.gymnastId, in: next.gymnastId, position: row.position },
      });
    });
    return this.changed(competitionId);
  }

  private async started(competitionId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: performances.id })
      .from(performances)
      .where(and(eq(performances.competitionId, competitionId), eq(performances.stage, "FINAL")))
      .limit(1);
    return row !== undefined;
  }

  private async changed(competitionId: string): Promise<FinalsView> {
    const view = await this.view(competitionId);
    this.live.toCompetition(competitionId, LIVE_EVENTS.finals, view);
    return view;
  }
}

/**
 * Отбор в один финал. Ранжирование уже с учётом равенства (одинаковое место),
 * поэтому все, кто делит последнее проходное место, проходят. Лимит от клуба
 * считается по клубу, а без клуба — по команде.
 */
export function selectFinalists(
  competitionId: string,
  apparatus: Apparatus,
  categoryId: string | null,
  ranking: { rank: number; gymnast: { id: string; club: string | null; teamId: string | null }; score: { total: number } }[],
  active: Set<string>,
  input: CreateFinalsInput,
): FinalistRow[] {
  const perClub = new Map<string, number>();
  const eligible = ranking.filter(({ gymnast }) => {
    if (!active.has(gymnast.id)) return false;
    const club = gymnast.club?.trim().toLowerCase() || gymnast.teamId;
    if (!club || input.perClub === null) return true;
    const count = perClub.get(club) ?? 0;
    if (count >= input.perClub) return false;
    perClub.set(club, count + 1);
    return true;
  });
  const cutRank = eligible[input.size - 1]?.rank ?? Infinity;
  const finals = eligible.filter((r, i) => i < input.size || r.rank === cutRank);
  const reserves = eligible.slice(finals.length, finals.length + input.reserves);
  const row = (r: (typeof ranking)[number], position: number, reserve: boolean): FinalistRow => ({
    competitionId,
    apparatus,
    categoryId,
    gymnastId: r.gymnast.id,
    position,
    reserve,
    qualRank: r.rank,
    qualTotal: toPoints(r.score.total),
  });
  return [
    ...shuffle(finals).map((r, i) => row(r, i + 1, false)),
    ...reserves.map((r, i) => row(r, i + 1, true)),
  ];
}

/** Случайная перестановка (Фишер — Йетс) на криптографическом генераторе. */
function shuffle<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
