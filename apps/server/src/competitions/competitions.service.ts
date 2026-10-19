import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apparatusFor } from "@ag/scoring";
import type {
  CreateCompetitionInput,
  CreateGymnastInput,
  CreateJudgeInput,
  CreateTeamInput,
} from "@ag/shared";
import { and, asc, eq } from "drizzle-orm";
import { hashToken, newToken } from "../auth/tokens";
import { DB, type Db } from "../db/db.module";
import { competitions, gymnasts, judges, teams } from "../db/schema";

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
