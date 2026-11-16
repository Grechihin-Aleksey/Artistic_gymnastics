import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { fromPoints, toPoints } from "@ag/scoring";
import type { CoachInquiryInput, CreateInquiryInput, InquiryView, ResolveInquiryInput } from "@ag/shared";
import { and, asc, desc, eq, gt, isNotNull } from "drizzle-orm";
import type { Principal } from "../auth/auth";
import { COACH_PHONE_ACTOR } from "../audit/audit.service";
import { DB, type Db } from "../db/db.module";
import { auditLog, competitions, gymnasts, inquiries, performances } from "../db/schema";
import { actorName, PerformancesService } from "../performances/performances.service";

/** Письменный запрос подаётся не позже чем через 4 минуты после показа оценки. */
const DEADLINE_MS = 4 * 60_000;

/**
 * Запросы тренеров на пересмотр оценки D. Секретариат записывает запрос
 * со слов тренера, апелляционное жюри решает: оставить оценку или поставить новую D.
 * Оценку E по правилам FIG оспорить нельзя.
 */
@Injectable()
export class InquiriesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly performances: PerformancesService,
  ) {}

  create(principal: Principal, performanceId: string, input: CreateInquiryInput): Promise<InquiryView> {
    return this.record(actorName(principal), "secretariat", performanceId, input);
  }

  /**
   * Тренер подаёт запрос сам, с телефона в сети зала: на последнюю утверждённую оценку
   * участника на снаряде в текущей части турнира. С телефона — только в срок; опоздавший
   * запрос, как и раньше, записывает секретариат.
   */
  async createFromCoach(competitionId: string, input: CoachInquiryInput): Promise<InquiryView> {
    const [competition] = await this.db
      .select({ phase: competitions.phase })
      .from(competitions)
      .where(eq(competitions.id, competitionId));
    if (!competition) throw new NotFoundException("Соревнование не найдено");
    const [perf] = await this.db
      .select({ id: performances.id, approvedAt: performances.approvedAt })
      .from(performances)
      .where(
        and(
          eq(performances.competitionId, competitionId),
          eq(performances.gymnastId, input.gymnastId),
          eq(performances.apparatus, input.apparatus),
          eq(performances.stage, competition.phase),
          eq(performances.status, "APPROVED"),
          isNotNull(performances.approvedAt),
        ),
      )
      .orderBy(desc(performances.approvedAt))
      .limit(1);
    if (!perf) throw new NotFoundException("У участника нет утверждённой оценки на этом снаряде");
    return this.record(COACH_PHONE_ACTOR, "phone", perf.id, input, true);
  }

  private async record(
    actor: string,
    source: "secretariat" | "phone",
    performanceId: string,
    input: CreateInquiryInput,
    onlyInTime = false,
  ): Promise<InquiryView> {
    const id = await this.db.transaction(async (tx) => {
      const [perf] = await tx
        .select()
        .from(performances)
        .where(eq(performances.id, performanceId))
        .for("update");
      if (!perf) throw new NotFoundException("Выступление не найдено");
      if (perf.status !== "APPROVED" || perf.d === null || !perf.approvedAt) {
        throw new ConflictException("Запрос подаётся на утверждённую оценку");
      }
      const [pending] = await tx
        .select({ id: inquiries.id })
        .from(inquiries)
        .where(and(eq(inquiries.performanceId, perf.id), eq(inquiries.status, "PENDING")));
      if (pending) throw new ConflictException("По этому выступлению уже есть нерассмотренный запрос");

      // Срок — до показа оценки следующего участника на этом снаряде.
      const [next] = await tx
        .select({ id: performances.id })
        .from(performances)
        .where(
          and(
            eq(performances.competitionId, perf.competitionId),
            eq(performances.apparatus, perf.apparatus),
            gt(performances.approvedAt, perf.approvedAt),
          ),
        )
        .limit(1);
      const late = Boolean(next) || Date.now() - perf.approvedAt.getTime() > DEADLINE_MS;
      if (late && onlyInTime) {
        throw new ConflictException(
          "Срок подачи прошёл: запрос подаётся до показа оценки следующего участника на этом снаряде и не позже 4 минут. Обратитесь в секретариат.",
        );
      }

      const [row] = await tx
        .insert(inquiries)
        .values({
          competitionId: perf.competitionId,
          performanceId: perf.id,
          coach: input.coach,
          claimedD: input.claimedD === undefined ? null : toPoints(input.claimedD),
          previousD: perf.d,
          late,
          source,
        })
        .returning({ id: inquiries.id });
      await tx.insert(auditLog).values({
        competitionId: perf.competitionId,
        actor,
        action: "inquiry.created",
        details: { inquiryId: row!.id, performanceId: perf.id, coach: input.coach, claimedD: input.claimedD ?? null, late, source },
      });
      return row!.id;
    });
    return this.view(id);
  }

  async list(competitionId: string): Promise<InquiryView[]> {
    const rows = await this.db
      .select({ id: inquiries.id })
      .from(inquiries)
      .where(eq(inquiries.competitionId, competitionId))
      .orderBy(asc(inquiries.createdAt));
    return Promise.all(rows.map((r) => this.view(r.id)));
  }

  async resolve(principal: Principal, id: string, input: ResolveInquiryInput): Promise<InquiryView> {
    const { competitionId, performanceId, changed } = await this.db.transaction(async (tx) => {
      const [inquiry] = await tx.select().from(inquiries).where(eq(inquiries.id, id)).for("update");
      if (!inquiry) throw new NotFoundException("Запрос не найден");
      if (inquiry.status !== "PENDING") throw new ConflictException("Запрос уже рассмотрен");
      const [perf] = await tx
        .select()
        .from(performances)
        .where(eq(performances.id, inquiry.performanceId))
        .for("update");
      if (!perf || perf.status !== "APPROVED" || perf.e === null) {
        throw new ConflictException("Оценка возвращена на правку: сначала утвердите её снова");
      }

      let newD: number | null = null;
      let changed = false;
      if (input.decision === "accept") {
        newD = toPoints(input.d);
        changed = newD !== perf.d;
        const total = Math.max(0, newD + perf.e - (perf.neutral ?? 0));
        await tx.update(performances).set({ d: newD, total }).where(eq(performances.id, perf.id));
      }
      await tx
        .update(inquiries)
        .set({
          status: input.decision === "accept" ? "ACCEPTED" : "REJECTED",
          newD,
          note: input.note ?? null,
          resolvedAt: new Date(),
        })
        .where(eq(inquiries.id, id));
      await tx.insert(auditLog).values({
        competitionId: perf.competitionId,
        actor: actorName(principal),
        action: input.decision === "accept" ? "inquiry.accepted" : "inquiry.rejected",
        details: { inquiryId: id, performanceId: perf.id, previousD: perf.d, newD, previousTotal: perf.total },
      });
      return { competitionId: perf.competitionId, performanceId: perf.id, changed };
    });
    if (changed) await this.performances.announceApproved(competitionId, performanceId);
    return this.view(id);
  }

  private async view(id: string): Promise<InquiryView> {
    const [row] = await this.db
      .select({ inquiry: inquiries, perf: performances, gymnast: gymnasts })
      .from(inquiries)
      .innerJoin(performances, eq(performances.id, inquiries.performanceId))
      .innerJoin(gymnasts, eq(gymnasts.id, performances.gymnastId))
      .where(eq(inquiries.id, id));
    if (!row) throw new NotFoundException("Запрос не найден");
    const { inquiry, perf, gymnast } = row;
    return {
      id: inquiry.id,
      competitionId: inquiry.competitionId,
      performanceId: inquiry.performanceId,
      apparatus: perf.apparatus,
      attempt: perf.attempt,
      gymnast: {
        id: gymnast.id,
        bib: gymnast.bib,
        firstName: gymnast.firstName,
        lastName: gymnast.lastName,
        club: gymnast.club,
        categoryId: gymnast.categoryId,
        teamId: gymnast.teamId,
      },
      coach: inquiry.coach,
      claimedD: inquiry.claimedD === null ? null : fromPoints(inquiry.claimedD),
      previousD: fromPoints(inquiry.previousD),
      newD: inquiry.newD === null ? null : fromPoints(inquiry.newD),
      status: inquiry.status,
      late: inquiry.late,
      source: inquiry.source === "phone" ? "phone" : "secretariat",
      note: inquiry.note,
      createdAt: inquiry.createdAt.toISOString(),
      resolvedAt: inquiry.resolvedAt?.toISOString() ?? null,
    };
  }
}
