import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apparatusFor, defaultStart, fromPoints, toPoints } from "@ag/scoring";
import type {
  CreateCompetitionInput,
  CreateGymnastInput,
  CreateJudgeInput,
  CreateTeamInput,
  ImportGymnastsInput,
  NormativesView,
  RulesView,
  SetNormativesInput,
  ClubStandingSettings,
  SetOfficialsInput,
  SetRulesInput,
  UpdateGymnastInput,
} from "@ag/shared";
import { and, asc, eq, inArray, isNull, max } from "drizzle-orm";
import { hashToken, newToken } from "../auth/tokens";
import { DB, type Db } from "../db/db.module";
import { auditLog, categories, competitions, gymnasts, judges, performances, shifts, teams } from "../db/schema";

export type CompetitionRow = typeof competitions.$inferSelect;

/** Участник в записи журнала: после удаления его уже не найти по id. */
const gymnastNote = (g: typeof gymnasts.$inferSelect) => ({ gymnastId: g.id, bib: g.bib, name: `${g.lastName} ${g.firstName}` });

/** Соревнование для клиентов: сам логотип отдаётся отдельно, он тяжёлый. */
export function publicCompetition({ logo, deductions, entryKey: _key, ...rest }: CompetitionRow) {
  return {
    ...rest,
    deductions: deductions.map((d) => ({ name: d.name, value: fromPoints(d.value) })),
    hasLogo: logo !== null,
  };
}

const toBalls = (record: Partial<Record<string, number>>) =>
  Object.fromEntries(Object.entries(record).map(([k, v]) => [k, fromPoints(v!)]));

/** Ключи по алфавиту, чтобы сравнение баз не зависело от их порядка. */
function sortKeys(record: Partial<Record<string, number>>) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];

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
        rules: input.rules,
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

  /** Сохраняет логотип для шапки протоколов; null — убрать. */
  async setLogo(id: string, dataUrl: string | null) {
    if (dataUrl !== null) {
      const [, type, base64] = /^data:image\/(png|jpeg);base64,(.*)$/.exec(dataUrl) ?? [];
      const head = [...Buffer.from(base64 ?? "", "base64").subarray(0, 4)];
      const magic = type === "png" ? PNG : JPEG;
      if (!magic.every((b, i) => head[i] === b)) {
        throw new BadRequestException("Файл не похож на картинку PNG или JPEG");
      }
    }
    const [row] = await this.db.update(competitions).set({ logo: dataUrl }).where(eq(competitions.id, id)).returning();
    if (!row) throw new NotFoundException("Соревнование не найдено");
    return publicCompetition(row);
  }

  async getRules(competitionId: string): Promise<RulesView> {
    const competition = await this.get(competitionId);
    const rows = await this.db
      .select()
      .from(categories)
      .where(eq(categories.competitionId, competitionId))
      .orderBy(asc(categories.position));
    const scored = new Set(
      (
        await this.db
          .selectDistinct({ categoryId: gymnasts.categoryId })
          .from(performances)
          .innerJoin(gymnasts, eq(gymnasts.id, performances.gymnastId))
          .where(eq(performances.competitionId, competitionId))
      ).map((r) => r.categoryId),
    );
    return {
      rules: competition.rules,
      deductions: publicCompetition(competition).deductions,
      categories: rows.map((c) => ({
        id: c.id,
        name: c.name,
        base: c.base === null ? null : fromPoints(c.base),
        apparatus: sortKeys(toBalls(c.apparatusBase)),
        scored: scored.has(c.id),
      })),
      scored: scored.size > 0,
    };
  }

  /**
   * Правила судейства. Пока нет оценок, менять можно всё. Когда оценки появились,
   * FIG и свои правила уже не переключить, а базу нельзя менять в тех разрядах,
   * где уже выступали: утверждённые итоги разошлись бы с новой базой.
   * Список сбавок можно дополнять в любой момент — он только подсказка судье.
   */
  async setRules(competitionId: string, input: SetRulesInput): Promise<RulesView> {
    const current = await this.getRules(competitionId);
    if (input.rules !== current.rules && current.scored) {
      throw new ConflictException("Оценки уже ставятся: правила судейства менять нельзя");
    }
    const known = new Map(current.categories.map((c) => [c.id, c]));
    const program = new Set<string>(apparatusFor((await this.get(competitionId)).discipline));
    for (const b of input.bases) {
      const category = known.get(b.categoryId);
      if (!category) throw new BadRequestException("Разряд не найден в этом соревновании");
      for (const a of Object.keys(b.apparatus)) {
        if (!program.has(a)) throw new BadRequestException(`Снаряда ${a} нет в программе соревнования`);
      }
      const same =
        category.base === b.base && JSON.stringify(category.apparatus) === JSON.stringify(sortKeys(b.apparatus));
      if (!same && category.scored) {
        throw new ConflictException(`В разряде «${category.name}» уже есть оценки: базу менять нельзя`);
      }
    }
    await this.db.transaction(async (tx) => {
      await tx
        .update(competitions)
        .set({
          rules: input.rules,
          deductions: input.deductions.map((d) => ({ name: d.name, value: toPoints(d.value) })),
        })
        .where(eq(competitions.id, competitionId));
      for (const b of input.bases) {
        await tx
          .update(categories)
          .set({
            base: b.base === null ? null : toPoints(b.base),
            apparatusBase: Object.fromEntries(Object.entries(b.apparatus).map(([k, v]) => [k, toPoints(v!)])),
          })
          .where(eq(categories.id, b.categoryId));
      }
      await tx.insert(auditLog).values({ competitionId, actor: "admin", action: "rules.changed", details: input });
    });
    return this.getRules(competitionId);
  }

  async setOfficials(competitionId: string, input: SetOfficialsInput) {
    await this.get(competitionId);
    const [row] = await this.db
      .update(competitions)
      .set({ officials: input })
      .where(eq(competitions.id, competitionId))
      .returning();
    return publicCompetition(row!);
  }

  async setClubStanding(competitionId: string, input: ClubStandingSettings) {
    await this.get(competitionId);
    const [row] = await this.db
      .update(competitions)
      .set({ clubStanding: input })
      .where(eq(competitions.id, competitionId))
      .returning();
    return publicCompetition(row!);
  }

  async getNormatives(competitionId: string): Promise<NormativesView> {
    await this.get(competitionId);
    const rows = await this.db
      .select()
      .from(categories)
      .where(eq(categories.competitionId, competitionId))
      .orderBy(asc(categories.position));
    return {
      categories: rows.map((c) => ({
        id: c.id,
        name: c.name,
        levels: c.normatives.map((l) => ({ name: l.name, min: fromPoints(l.min) })),
      })),
    };
  }

  /** Нормативы можно менять в любой момент: выполнение считается по ним заново. */
  async setNormatives(competitionId: string, input: SetNormativesInput): Promise<NormativesView> {
    const known = new Set((await this.getNormatives(competitionId)).categories.map((c) => c.id));
    for (const c of input.categories) {
      if (!known.has(c.categoryId)) throw new BadRequestException("Разряд не найден в этом соревновании");
      const names = c.levels.map((l) => l.name.toLowerCase());
      if (new Set(names).size !== names.length) throw new BadRequestException("Уровни разряда повторяются");
    }
    await this.db.transaction(async (tx) => {
      for (const c of input.categories) {
        const levels = c.levels
          .map((l) => ({ name: l.name, min: toPoints(l.min) }))
          .sort((a, b) => b.min - a.min);
        await tx.update(categories).set({ normatives: levels }).where(eq(categories.id, c.categoryId));
      }
    });
    return this.getNormatives(competitionId);
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
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(gymnasts).values({ competitionId, ...input }).returning();
      await tx.insert(auditLog).values({ competitionId, actor: "admin", action: "gymnast.added", details: gymnastNote(row!) });
      return row!;
    });
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

      const created = await tx
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
              middleName: r.middleName || null,
              birthDate: r.birthDate || null,
              city: r.city || null,
              coach: r.coach || null,
              teamId: r.team ? teamIds.get(teamKey(r.team, categoryId))! : null,
              categoryId,
              shift: r.shift ?? null,
              startOrder,
            };
          }),
        )
        .returning();
      await tx.insert(auditLog).values({
        competitionId,
        actor: "admin",
        action: "gymnasts.imported",
        details: { count: created.length, bibs: created.map((g) => g.bib) },
      });
      return created;
    });
  }

  /**
   * Правка участника. Разряд нельзя сменить, когда у участника уже есть оценки:
   * по своим правилам от разряда зависит база. Номер должен быть свободен.
   */
  async updateGymnast(competitionId: string, gymnastId: string, input: UpdateGymnastInput) {
    const competition = await this.get(competitionId);
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(gymnasts)
        .where(and(eq(gymnasts.id, gymnastId), eq(gymnasts.competitionId, competitionId)))
        .for("update");
      if (!current) throw new NotFoundException("Участник не найден");
      const changes: Partial<typeof gymnasts.$inferInsert> = {};
      for (const key of ["lastName", "firstName", "status"] as const) {
        if (input[key] !== undefined) Object.assign(changes, { [key]: input[key] });
      }
      for (const key of ["club", "middleName", "birthDate", "city", "coach"] as const) {
        if (input[key] !== undefined) changes[key] = input[key] || null;
      }

      if (input.bib !== undefined && input.bib !== current.bib) {
        const [taken] = await tx
          .select({ lastName: gymnasts.lastName, firstName: gymnasts.firstName })
          .from(gymnasts)
          .where(and(eq(gymnasts.competitionId, competitionId), eq(gymnasts.bib, input.bib)));
        if (taken) throw new ConflictException(`Номер ${input.bib} уже у участника ${taken.lastName} ${taken.firstName}`);
        changes.bib = input.bib;
      }

      let categoryId = current.categoryId;
      if (input.category !== undefined) {
        if (input.category) {
          const [found] = await tx
            .select()
            .from(categories)
            .where(and(eq(categories.competitionId, competitionId), eq(categories.name, input.category)));
          if (found) categoryId = found.id;
          else {
            const [{ value } = { value: null }] = await tx
              .select({ value: max(categories.position) })
              .from(categories)
              .where(eq(categories.competitionId, competitionId));
            const [row] = await tx
              .insert(categories)
              .values({ competitionId, name: input.category, position: (value ?? -1) + 1 })
              .returning();
            categoryId = row!.id;
          }
        } else categoryId = null;
        if (categoryId !== current.categoryId) {
          const [scored] = await tx
            .select({ id: performances.id })
            .from(performances)
            .where(eq(performances.gymnastId, gymnastId))
            .limit(1);
          if (scored) throw new ConflictException("У участника уже есть оценки: разряд менять нельзя");
          changes.categoryId = categoryId;
        }
      }

      // Команда принадлежит разряду: ищем её в разряде участника.
      const teamName = input.team !== undefined ? input.team || null : null;
      if (input.team !== undefined || changes.categoryId !== undefined) {
        const name =
          input.team !== undefined
            ? teamName
            : current.teamId
              ? ((await tx.select({ name: teams.name }).from(teams).where(eq(teams.id, current.teamId)))[0]?.name ?? null)
              : null;
        if (name) {
          const sameCategory = categoryId === null ? isNull(teams.categoryId) : eq(teams.categoryId, categoryId);
          const [found] = await tx
            .select()
            .from(teams)
            .where(and(eq(teams.competitionId, competitionId), eq(teams.name, name), sameCategory));
          changes.teamId =
            found?.id ?? (await tx.insert(teams).values({ competitionId, name, categoryId }).returning())[0]!.id;
        } else changes.teamId = null;
      }

      if (input.shift !== undefined && input.shift !== current.shift) {
        changes.shift = input.shift;
        changes.startOrder = null;
        if (input.shift !== null) {
          const [known] = await tx
            .select({ id: shifts.id })
            .from(shifts)
            .where(and(eq(shifts.competitionId, competitionId), eq(shifts.number, input.shift)));
          if (!known) {
            await tx
              .insert(shifts)
              .values({ competitionId, number: input.shift, startApparatus: defaultStart(competition.discipline, input.shift) });
          }
          // В новой смене — последним.
          const [last] = await tx
            .select({ value: max(gymnasts.startOrder) })
            .from(gymnasts)
            .where(and(eq(gymnasts.competitionId, competitionId), eq(gymnasts.shift, input.shift)));
          changes.startOrder = (last?.value ?? 0) + 1;
        }
      }

      if (Object.keys(changes).length === 0) return current;
      const [row] = await tx.update(gymnasts).set(changes).where(eq(gymnasts.id, gymnastId)).returning();
      // В журнал — понятные названия: разряд и команду по имени, а не по id.
      const nameOf = async (table: typeof categories | typeof teams, id: string | null) =>
        id ? ((await tx.select({ name: table.name }).from(table).where(eq(table.id, id)))[0]?.name ?? null) : null;
      const diff: Record<string, { from: unknown; to: unknown }> = {};
      for (const key of Object.keys(changes) as (keyof typeof changes)[]) {
        if (key === "startOrder") continue;
        if (key === "categoryId") diff.category = { from: await nameOf(categories, current.categoryId), to: await nameOf(categories, row!.categoryId) };
        else if (key === "teamId") diff.team = { from: await nameOf(teams, current.teamId), to: await nameOf(teams, row!.teamId) };
        else if (current[key] !== row![key]) diff[key] = { from: current[key], to: row![key] };
      }
      if (diff.team && diff.team.from === diff.team.to) delete diff.team;
      if (Object.keys(diff).length > 0) {
        await tx.insert(auditLog).values({ competitionId, actor: "admin", action: "gymnast.updated", details: { ...gymnastNote(current), changes: diff } });
      }
      return row!;
    });
  }

  /** Удалить можно только того, кто ещё не выступал; иначе — отметить «снятие». */
  async deleteGymnast(competitionId: string, gymnastId: string) {
    const [scored] = await this.db
      .select({ id: performances.id })
      .from(performances)
      .where(eq(performances.gymnastId, gymnastId))
      .limit(1);
    if (scored) throw new ConflictException("Участник уже выступал: удалить нельзя, отметьте «снятие»");
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .delete(gymnasts)
        .where(and(eq(gymnasts.id, gymnastId), eq(gymnasts.competitionId, competitionId)))
        .returning();
      if (!row) throw new NotFoundException("Участник не найден");
      await tx.insert(auditLog).values({ competitionId, actor: "admin", action: "gymnast.deleted", details: gymnastNote(row) });
      return { deleted: row.id };
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
    if (input.enterAllMarks && input.role !== "SUPERVISOR") {
      throw new BadRequestException("Один планшет на снаряд выдаётся старшему судье");
    }
    const token = newToken();
    const [row] = await this.db
      .insert(judges)
      .values({ competitionId, ...input, tokenHash: hashToken(token) })
      .returning();
    const { tokenHash: _, ...judge } = row!;
    await this.db.insert(auditLog).values({ competitionId, actor: "admin", action: "judge.added", details: { judgeId: judge.id } });
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
    await this.db
      .insert(auditLog)
      .values({ competitionId: row.competitionId, actor: "admin", action: "judge.token_reissued", details: { judgeId: row.id } });
    return { ...judge, token };
  }

  /** Бригада снаряда без токенов: планшету снаряда нужны места и фамилии судей. */
  async panel(competitionId: string, apparatus: string) {
    const rows = await this.db
      .select({ id: judges.id, name: judges.name, role: judges.role, seat: judges.seat })
      .from(judges)
      .where(and(eq(judges.competitionId, competitionId), eq(judges.apparatus, apparatus as never)))
      .orderBy(asc(judges.role), asc(judges.seat));
    return rows;
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
