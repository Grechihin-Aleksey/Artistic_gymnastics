import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import {
  apparatusSchema,
  createPerformanceSchema,
  manualScoreSchema,
  recoverFromTabletSchema,
  reopenPerformanceSchema,
  submitMarkSchema,
  tabletScoreSchema,
  type CreatePerformanceInput,
  type ManualScoreInput,
  type RecoverFromTabletInput,
  type ReopenPerformanceInput,
  type SubmitMarkInput,
  type TabletScoreInput,
} from "@ag/shared";
import { AllowChief, CurrentPrincipal, RequireAccess, type Principal } from "../auth/auth";
import { ZodPipe } from "../zod.pipe";
import { PerformancesService } from "./performances.service";

@Controller()
export class PerformancesController {
  constructor(private readonly performances: PerformancesService) {}

  /** Вызывает участника секретариат или старший судья своего снаряда. */
  @Post("competitions/:id/performances")
  @RequireAccess("admin-or-judge")
  create(
    @CurrentPrincipal() principal: Principal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(createPerformanceSchema)) body: CreatePerformanceInput,
  ) {
    return this.performances.create(principal, id, body);
  }

  /** Оценки с судейских листов: секретариат вводит или исправляет, когда планшеты без связи. */
  @Post("competitions/:id/manual-scores")
  @RequireAccess("admin")
  scoreManually(
    @CurrentPrincipal() principal: Principal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(manualScoreSchema)) body: ManualScoreInput,
  ) {
    return this.performances.scoreManually(principal, id, body);
  }

  /** После восстановления базы: попросить планшеты прислать сохранённые у них оценки. */
  @Post("competitions/:id/recovery")
  @RequireAccess("admin")
  collectFromTablets(@Param("id", ParseUUIDPipe) id: string) {
    return this.performances.collectFromTablets(id);
  }

  /** Планшет присылает утверждённые выступления своего снаряда, которые помнит. */
  @Post("recovery")
  @RequireAccess("judge")
  recoverFromTablet(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(recoverFromTabletSchema)) body: RecoverFromTabletInput,
  ) {
    if (principal.kind !== "judge") throw new Error("unreachable");
    return this.performances.recoverFromTablet(principal.judge, body);
  }

  @Delete("performances/:id")
  @RequireAccess("admin")
  remove(@CurrentPrincipal() principal: Principal, @Param("id", ParseUUIDPipe) id: string) {
    return this.performances.remove(principal, id);
  }

  @Get("competitions/:id/performances")
  @RequireAccess("admin-or-judge")
  @AllowChief()
  list(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("apparatus", new ZodPipe(apparatusSchema.optional())) apparatus?: string,
  ) {
    return this.performances.list(id, apparatus);
  }

  @Get("performances/:id")
  @RequireAccess("admin-or-judge")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.performances.view(id);
  }

  @Post("marks")
  @RequireAccess("judge")
  submitMark(@CurrentPrincipal() principal: Principal, @Body(new ZodPipe(submitMarkSchema)) body: SubmitMarkInput) {
    if (principal.kind !== "judge") throw new Error("unreachable");
    return this.performances.submitMark(principal.judge, body);
  }

  @Post("performances/:id/approve")
  @RequireAccess("admin-or-judge")
  approve(@CurrentPrincipal() principal: Principal, @Param("id", ParseUUIDPipe) id: string) {
    return this.performances.approve(principal, id);
  }

  /** Один планшет на снаряд: старший судья вводит оценки всей бригады и сразу утверждает. */
  @Post("performances/:id/tablet-score")
  @RequireAccess("judge")
  scoreFromTablet(
    @CurrentPrincipal() principal: Principal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(tabletScoreSchema)) body: TabletScoreInput,
  ) {
    return this.performances.scoreFromTablet(principal, id, body);
  }

  @Post("performances/:id/reopen")
  @RequireAccess("admin")
  reopen(
    @CurrentPrincipal() principal: Principal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reopenPerformanceSchema)) body: ReopenPerformanceInput,
  ) {
    return this.performances.reopen(principal, id, body.reason);
  }
}
