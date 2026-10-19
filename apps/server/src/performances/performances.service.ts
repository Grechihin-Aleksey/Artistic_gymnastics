import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { apparatusFor, fromPoints, scorePerformance, toPoints } from "@ag/scoring";
import {
  LIVE_EVENTS,
  type CreatePerformanceInput,
  type MarkKind,
  type PerformanceView,
  type SubmitMarkInput,
} from "@ag/shared";
import { and, asc, eq } from "drizzle-orm";
import type { JudgeRow, Principal } from "../auth/auth";
import { CompetitionsService } from "../competitions/competitions.service";
import { DB, type Db } from "../db/db.module";
import { auditLog, gymnasts, judges, marks, performances } from "../db/schema";
import { LiveGateway } from "../live/live.gateway";

type PerformanceRow = typeof performances.$inferSelect;

/** Какие оценки может ставить каждая роль. */
const ALLOWED_KINDS: Record<JudgeRow["role"], readonly MarkKind[]> = {
  D: ["D", "NEUTRAL"],
  E: ["E"],
  SUPERVISOR: ["D", "NEUTRAL"],
};

export function actorName(principal: Principal): string {
  return principal.kind === "admin" ? "admin" : `judge:${principal.judge.id}`;
}

@Injectable()
export class PerformancesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly competitions: CompetitionsService,
    private readonly live: LiveGateway,
  ) {}

  /** Вызов участника на снаряд: открывает выступление для оценок. */
  async create(principal: Principal, competitionId: string, input: CreatePerformanceInput): Promise<PerformanceView> {
    if (principal.kind === "judge") {
      const { judge } = principal;
      if (judge.role !== "SUPERVISOR" || judge.competitionId !== competitionId || judge.apparatus !== input.apparatus) {
        throw new ForbiddenException("Вызывает старший судья этого снаряда или секретариат");
      }
    }
    const competition = await this.competitions.get(competitionId);
    if (!apparatusFor(competition.discipline).includes(input.apparatus)) {
      throw new BadRequestException(`Снаряда ${input.apparatus} нет в программе ${competition.discipline}`);
    }
    if (input.apparatus !== "VT" && input.attempt !== 1) {
      throw new BadRequestException("Вторая попытка бывает только в опорном прыжке");
    }
    const [gymnast] = await this.db
      .select()
      .from(gymnasts)
      .where(and(eq(gymnasts.id, input.gymnastId), eq(gymnasts.competitionId, competitionId)));
    if (!gymnast) throw new BadRequestException("Участник не найден в этом соревновании");
    // Судьи видят одно текущее выступление: следующего вызывают после утверждения.
    const [open] = await this.db
      .select({ gymnastId: performances.gymnastId })
      .from(performances)
      .where(
        and(
          eq(performances.competitionId, competitionId),
          eq(performances.apparatus, input.apparatus),
          eq(performances.status, "SCORING"),
        ),
      )
      .limit(1);
    if (open) throw new ConflictException("На снаряде ещё не утверждена оценка предыдущего участника");

    const [row] = await this.db
      .insert(performances)
      .values({ competitionId, ...input })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new ConflictException("Это выступление уже создано");
    const view = await this.view(row.id);
    this.live.toCompetition(competitionId, LIVE_EVENTS.called, this.publicView(view, competition.publishJudgeMarks));
    return view;
  }

  async list(competitionId: string, apparatus?: string): Promise<PerformanceView[]> {
    const rows = await this.db
      .select({ id: performances.id })
      .from(performances)
      .where(
        apparatus
          ? and(eq(performances.competitionId, competitionId), eq(performances.apparatus, apparatus as never))
          : eq(performances.competitionId, competitionId),
      )
      .orderBy(asc(performances.createdAt));
    return Promise.all(rows.map((r) => this.view(r.id)));
  }

  async view(id: string): Promise<PerformanceView> {
    const [row] = await this.db.select().from(performances).where(eq(performances.id, id));
    if (!row) throw new NotFoundException("Выступление не найдено");
    const markRows = await this.db
      .select({
        judgeId: marks.judgeId,
        kind: marks.kind,
        value: marks.value,
        seat: judges.seat,
        role: judges.role,
      })
      .from(marks)
      .innerJoin(judges, eq(judges.id, marks.judgeId))
      .where(eq(marks.performanceId, id))
      .orderBy(asc(judges.role), asc(judges.seat), asc(marks.kind));
    return {
      id: row.id,
      competitionId: row.competitionId,
      gymnastId: row.gymnastId,
      apparatus: row.apparatus,
      attempt: row.attempt,
      status: row.status,
      score:
        row.total === null
          ? null
          : {
              d: fromPoints(row.d ?? 0),
              e: fromPoints(row.e ?? 0),
              neutral: fromPoints(row.neutral ?? 0),
              total: fromPoints(row.total),
            },
      marks: markRows.map((m) => ({ ...m, value: fromPoints(m.value) })),
    };
  }

  /** Оценка судьи. Повторная отправка с тем же id ничего не меняет. */
  async submitMark(judge: JudgeRow, input: SubmitMarkInput): Promise<PerformanceView> {
    const value = toPoints(input.value);
    if (!ALLOWED_KINDS[judge.role].includes(input.kind)) {
      throw new ForbiddenException(`Судья ${judge.role} не ставит оценку ${input.kind}`);
    }
    if (input.kind === "E" && value > 10_000) {
      throw new BadRequestException("Сбавка E не может быть больше 10");
    }

    const [existing] = await this.db.select().from(marks).where(eq(marks.id, input.id));
    if (existing) {
      if (existing.judgeId !== judge.id) throw new ConflictException("Этот id уже занят другой оценкой");
      return this.view(existing.performanceId);
    }

    const perf = await this.db.transaction(async (tx) => {
      const [perf] = await tx
        .select()
        .from(performances)
        .where(eq(performances.id, input.performanceId))
        .for("update");
      if (!perf) throw new NotFoundException("Выступление не найдено");
      if (perf.competitionId !== judge.competitionId || perf.apparatus !== judge.apparatus) {
        throw new ForbiddenException("Выступление проходит не на вашем снаряде");
      }
      if (perf.status !== "SCORING") throw new ConflictException("Оценка уже утверждена");

      const [previous] = await tx
        .select()
        .from(marks)
        .where(
          and(eq(marks.performanceId, perf.id), eq(marks.judgeId, judge.id), eq(marks.kind, input.kind)),
        );
      if (previous) {
        await tx.update(marks).set({ value }).where(eq(marks.id, previous.id));
        await tx.insert(auditLog).values({
          competitionId: perf.competitionId,
          actor: `judge:${judge.id}`,
          action: "mark.changed",
          details: { performanceId: perf.id, kind: input.kind, from: previous.value, to: value },
        });
      } else {
        await tx.insert(marks).values({
          id: input.id,
          performanceId: perf.id,
          judgeId: judge.id,
          kind: input.kind,
          value,
        }).onConflictDoNothing({ target: marks.id });
      }
      return perf;
    });

    const view = await this.view(perf.id);
    this.live.toPanel(perf.competitionId, perf.apparatus, LIVE_EVENTS.marksUpdated, view);
    return view;
  }

  /** Утверждение оценки: сервер считает итог по правилам FIG и публикует его. */
  async approve(principal: Principal, id: string): Promise<PerformanceView> {
    const competitionId = await this.db.transaction(async (tx) => {
      const [perf] = await tx.select().from(performances).where(eq(performances.id, id)).for("update");
      if (!perf) throw new NotFoundException("Выступление не найдено");
      this.assertCanApprove(principal, perf);
      if (perf.status !== "SCORING") throw new ConflictException("Оценка уже утверждена");

      const markRows = await tx
        .select({ kind: marks.kind, value: marks.value })
        .from(marks)
        .where(eq(marks.performanceId, id));
      const eJudges = await tx
        .select({ id: judges.id })
        .from(judges)
        .where(
          and(
            eq(judges.competitionId, perf.competitionId),
            eq(judges.apparatus, perf.apparatus),
            eq(judges.role, "E"),
          ),
        );

      const dValues = new Set(markRows.filter((m) => m.kind === "D").map((m) => m.value));
      const neutralValues = new Set(markRows.filter((m) => m.kind === "NEUTRAL").map((m) => m.value));
      const eDeductions = markRows.filter((m) => m.kind === "E").map((m) => m.value);

      if (dValues.size === 0) throw new ConflictException("Нет оценки D");
      if (dValues.size > 1) throw new ConflictException("Оценки D у судей расходятся");
      if (neutralValues.size > 1) throw new ConflictException("Нейтральные сбавки у судей расходятся");
      if (eJudges.length === 0) throw new ConflictException("В бригаде нет судей E");
      if (eDeductions.length < eJudges.length) {
        throw new ConflictException(`Оценки E: ${eDeductions.length} из ${eJudges.length}`);
      }

      const score = scorePerformance({
        d: [...dValues][0]!,
        eDeductions,
        neutral: [...neutralValues][0] ?? 0,
      });
      await tx
        .update(performances)
        .set({ status: "APPROVED", ...score, approvedAt: new Date() })
        .where(eq(performances.id, id));
      await tx.insert(auditLog).values({
        competitionId: perf.competitionId,
        actor: actorName(principal),
        action: "performance.approved",
        details: { performanceId: id, ...score },
      });
      return perf.competitionId;
    });

    return this.announceApproved(competitionId, id);
  }

  /** Сообщает залу и сайту об утверждённой (или изменённой по запросу) оценке. */
  async announceApproved(competitionId: string, id: string): Promise<PerformanceView> {
    const competition = await this.competitions.get(competitionId);
    const view = await this.view(id);
    this.live.toCompetition(competitionId, LIVE_EVENTS.approved, this.publicView(view, competition.publishJudgeMarks));
    return view;
  }

  /** Возврат утверждённой оценки на правку, например по запросу на пересмотр D. */
  async reopen(principal: Principal, id: string, reason: string): Promise<PerformanceView> {
    const perf = await this.db.transaction(async (tx) => {
      const [perf] = await tx.select().from(performances).where(eq(performances.id, id)).for("update");
      if (!perf) throw new NotFoundException("Выступление не найдено");
      if (perf.status !== "APPROVED") throw new ConflictException("Оценка ещё не утверждена");
      await tx
        .update(performances)
        .set({ status: "SCORING", d: null, e: null, neutral: null, total: null, approvedAt: null })
        .where(eq(performances.id, id));
      await tx.insert(auditLog).values({
        competitionId: perf.competitionId,
        actor: actorName(principal),
        action: "performance.reopened",
        details: { performanceId: id, reason, previousTotal: perf.total },
      });
      return perf;
    });
    const view = await this.view(id);
    this.live.toCompetition(perf.competitionId, LIVE_EVENTS.reopened, { id, reason });
    this.live.toPanel(perf.competitionId, perf.apparatus, LIVE_EVENTS.marksUpdated, view);
    return view;
  }

  private assertCanApprove(principal: Principal, perf: PerformanceRow): void {
    if (principal.kind === "admin") return;
    const { judge } = principal;
    if (
      judge.role !== "SUPERVISOR" ||
      judge.competitionId !== perf.competitionId ||
      judge.apparatus !== perf.apparatus
    ) {
      throw new ForbiddenException("Утверждает старший судья этого снаряда или секретариат");
    }
  }

  /** Для табло и сайта: оценки отдельных судей только если соревнование их публикует. */
  private publicView(view: PerformanceView, publishJudgeMarks: boolean): PerformanceView {
    return publishJudgeMarks ? view : { ...view, marks: [] };
  }
}
