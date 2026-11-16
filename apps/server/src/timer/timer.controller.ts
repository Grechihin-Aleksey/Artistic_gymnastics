import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from "@nestjs/common";
import { LIVE_EVENTS, setBoardTimerSchema, type BoardTimer, type SetBoardTimerInput } from "@ag/shared";
import { and, eq, ne } from "drizzle-orm";
import { Inject } from "@nestjs/common";
import { RequireAccess } from "../auth/auth";
import { CompetitionsService } from "../competitions/competitions.service";
import { DB, type Db } from "../db/db.module";
import { competitions } from "../db/schema";
import { LiveGateway } from "../live/live.gateway";
import { ZodPipe } from "../zod.pipe";

/** После нуля табло ещё столько показывает «Время!», потом таймер пропадает. */
export const TIMER_AFTERGLOW_MS = 5000;

/**
 * Таймер на табло в зале: секретарь запускает обратный отсчёт разминки, ротации
 * или перерыва. Хранится в памяти сервера: после перезапуска его просто запускают снова.
 */
@Controller("competitions/:id/timer")
export class TimerController {
  private readonly timers = new Map<string, { label: string; seconds: number; endsAt: number }>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly competitions: CompetitionsService,
    private readonly live: LiveGateway,
  ) {}

  @Get()
  get(@Param("id", ParseUUIDPipe) id: string): { timer: BoardTimer | null } {
    return { timer: this.view(id) };
  }

  @Put()
  @RequireAccess("admin")
  async set(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(setBoardTimerSchema)) body: SetBoardTimerInput,
  ): Promise<{ timer: BoardTimer | null }> {
    const competition = await this.competitions.get(id);
    // У турнира девочек и мальчиков табло одно на обе части: таймер идёт у обеих.
    const partners = competition.pairId
      ? await this.db
          .select({ id: competitions.id })
          .from(competitions)
          .where(and(eq(competitions.pairId, competition.pairId), ne(competitions.id, id)))
      : [];
    for (const part of [id, ...partners.map((p) => p.id)]) {
      if (body.timer) this.timers.set(part, { ...body.timer, endsAt: Date.now() + body.timer.seconds * 1000 });
      else this.timers.delete(part);
      this.live.toCompetition(part, LIVE_EVENTS.timer, this.view(part));
    }
    return { timer: this.view(id) };
  }

  private view(id: string): BoardTimer | null {
    const t = this.timers.get(id);
    if (!t) return null;
    const remainingMs = t.endsAt - Date.now();
    if (remainingMs < -TIMER_AFTERGLOW_MS) {
      this.timers.delete(id);
      return null;
    }
    return { label: t.label, seconds: t.seconds, remainingMs: Math.max(0, remainingMs) };
  }
}
