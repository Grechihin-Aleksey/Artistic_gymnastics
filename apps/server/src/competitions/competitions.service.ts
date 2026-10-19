import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apparatusFor, defaultStart } from "@ag/scoring";
import type {
  CreateCompetitionInput,
  CreateGymnastInput,
  CreateJudgeInput,
  CreateTeamInput,
  ImportGymnastsInput,
} from "@ag/shared";
import { and, asc, eq, inArray, max } from "drizzle-orm";
import { hashToken, newToken } from "../auth/tokens";
import { DB, type Db } from "../db/db.module";
import { categories, competitions, gymnasts, judges, shifts, teams } from "../db/schema";

export type CompetitionRow = typeof competitions.$inferSelect;

@Injectable()
export class CompetitionsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(input: CreateCompetitionInput): Promise<CompetitionRow> {
    const format = input.teamFormat ?? { roster: 5, perApparatus: 4, counting: 3 };
    if (format.counting > format.perApparatus || format.perApparatus > format.roster) {
      throw new BadRequestException("Формат команды: в зачёт ≤ выступают ≤ в составе");
    }
    const [row] = await this.db
      .insert(competitions)
      .values({
        name: input.name,
        discipline: input.discipline,
        teamRoster: format.roster,
        teamPerApparatus: format.perApparatus,
        teamCounting: format.counting,
        publishJudgeMarks: input.publishJudgeMarks,
      })
      .returning();
    return row!;
  }

  list(): Promise<CompetitionRow[]> {
    return this.db.select().from(competitions).orderBy(asc(competitions.createdAt));
  }

  async get(id: string): Promise<CompetitionRow> {
    const [row] = await this.db.select().from(competitions).where(eq(competitions.id, id));
    if (!row) throw new NotFoundException("Соревнование не найдено");
    return row;
  }

  async addTeam(competitionId: string, input: CreateTeamInput) {
    await this.get(competitionId);
    const [row] = await this.db.insert(teams).values({ competitionId, name: input.name }).returning();
    return row!;
  }

  async listTeams(competitionId: string) {
    return this.db.select().from(teams).where(eq(teams.competitionId, competitionId)).orderBy(asc(teams.name));
  }

  async addGymnast(competitionId: string, input: CreateGymnastInput) {
    await this.get(competitionId);
    if (input.teamId) {
      const [team] = await this.db
        .select()
        .from(teams)
        .where(and(eq(teams.id, input.teamId), eq(teams.competitionId, competitionId)));
      if (!team) throw new BadRequestException("Команда не найдена в этом соревновании");
    }
    const [row] = await this.db
      .insert(gymnasts)
      .values({ competitionId, ...input })
      .returning();
    return row!;
  }

  /**
   * Добавляет участников списком. Разряды, команды и смены находит по названию
   * (номеру) или создаёт. Команда принадлежит разряду: одноимённые команды
   * разных разрядов считаются отдельно. Порядок выхода в смене — порядок строк.
   * Всё или ничего: при ошибке в любой строке список не меняется.
   */
  async importGymnasts(competitionId: string, input: ImportGymnastsInput) {
    const competition = await this.get(competitionId);
    const bibs = input.rows.map((r) => r.bib);
    const repeated = bibs.filter((b, i) => bibs.indexOf(b) !== i);
    if (repeated.length > 0) {
      throw new BadRequestException(`Номера повторяются в списке: ${[...new Set(repeated)].join(", ")}`);
    }
    return this.db.transaction(async (tx) => {
      const taken = await tx
        .select({ bib: gymnasts.bib })
        .from(gymnasts)
        .where(and(eq(gymnasts.competitionId, competitionId), inArray(gymnasts.bib, bibs)));
      if (taken.length > 0) {
        throw new BadRequestException(`Номера уже заняты: ${taken.map((t) => t.bib).join(", ")}`);
      }

      const existingCategories = await tx.select().from(categories).where(eq(categories.competitionId, competitionId));
      const categoryIds = new Map(existingCategories.map((c) => [c.name, c.id]));
      let position = Math.max(-1, ...existingCategories.map((c) => c.position));
      for (const name of new Set(input.rows.map((r) => r.category).filter((c): c is string => Boolean(c)))) {
        if (categoryIds.has(name)) continue;
        const [row] = await tx.insert(categories).values({ competitionId, name, position: ++position }).returning();
        categoryIds.set(name, row!.id);
      }
      const categoryOf = (name: string | undefined) => (name ? categoryIds.get(name)! : null);

      const teamKey = (name: string, categoryId: string | null) => `${categoryId ?? ""}\u0000${name}`;
      const teamIds = new Map(
        (await tx.select().from(teams).where(eq(teams.competitionId, competitionId))).map((t) => [
          teamKey(t.name, t.categoryId),
          t.id,
        ]),
      );
      for (const r of input.rows) {
        if (!r.team) continue;
        const categoryId = categoryOf(r.category);
        const key = teamKey(r.team, categoryId);
        if (teamIds.has(key)) continue;
        const [team] = await tx.insert(teams).values({ competitionId, name: r.team, categoryId }).returning();
        teamIds.set(key, team!.id);
      }

      const shiftNumbers = [...new Set(input.rows.map((r) => r.shift).filter((n): n is number => n !== undefined))];
      const nextOrder = new Map<number, number>();
      if (shiftNumbers.length > 0) {
        const known = new Set(
          (await tx.select({ number: shifts.number }).from(shifts).where(eq(shifts.competitionId, competitionId))).map(
            (s) => s.number,
          ),
        );
        for (const number of shiftNumbers) {
          if (!known.has(number)) {
            await tx
              .insert(shifts)
              .values({ competitionId, number, startApparatus: defaultStart(competition.discipline, number) });
          }
          const [last] = await tx
            .select({ value: max(gymnasts.startOrder) })
            .from(gymnasts)
            .where(and(eq(gymnasts.competitionId, competitionId), eq(gymnasts.shift, number)));
          nextOrder.set(number, (last?.value ?? 0) + 1);
        }
      }

      return tx
        .insert(gymnasts)
        .values(
          input.rows.map((r) => {
            const categoryId = categoryOf(r.category);
            let startOrder: number | null = null;
            if (r.shift !== undefined) {
              startOrder = nextOrder.get(r.shift)!;
              nextOrder.set(r.shift, startOrder + 1);
            }
            return {
              competitionId,
              bib: r.bib,
              lastName: r.lastName,
              firstName: r.firstName,
              club: r.club ?? null,
              teamId: r.team ? teamIds.get(teamKey(r.team, categoryId))! : null,
              categoryId,
              shift: r.shift ?? null,
              startOrder,
            };
          }),
        )
        .returning();
    });
  }

  listCategories(competitionId: string) {
    return this.db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.competitionId, competitionId))
      .orderBy(asc(categories.position));
  }

  async listGymnasts(competitionId: string) {
    return this.db
      .select()
      .from(gymnasts)
      .where(eq(gymnasts.competitionId, competitionId))
      .orderBy(asc(gymnasts.bib));
  }

  /** Создаёт судью и один раз возвращает его токен входа. */
  async addJudge(competitionId: string, input: CreateJudgeInput) {
    const competition = await this.get(competitionId);
    if (!apparatusFor(competition.discipline).includes(input.apparatus)) {
      throw new BadRequestException(`Снаряда ${input.apparatus} нет в программе ${competition.discipline}`);
    }
    const token = newToken();
    const [row] = await this.db
      .insert(judges)
      .values({ competitionId, ...input, tokenHash: hashToken(token) })
      .returning();
    const { tokenHash: _, ...judge } = row!;
    return { ...judge, token };
  }

  /** Новый токен судьи взамен потерянного; старый перестаёт работать. */
  async reissueJudgeToken(judgeId: string) {
    const token = newToken();
    const [row] = await this.db
      .update(judges)
      .set({ tokenHash: hashToken(token) })
      .where(eq(judges.id, judgeId))
      .returning();
    if (!row) throw new NotFoundException("Судья не найден");
    const { tokenHash: _, ...judge } = row;
    return { ...judge, token };
  }

  async listJudges(competitionId: string) {
    const rows = await this.db
      .select()
      .from(judges)
      .where(eq(judges.competitionId, competitionId))
      .orderBy(asc(judges.apparatus), asc(judges.role), asc(judges.seat));
    return rows.map(({ tokenHash: _, ...judge }) => judge);
  }
}
