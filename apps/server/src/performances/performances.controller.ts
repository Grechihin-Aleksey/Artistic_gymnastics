import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import {
  apparatusSchema,
  createPerformanceSchema,
  reopenPerformanceSchema,
  submitMarkSchema,
  type CreatePerformanceInput,
  type ReopenPerformanceInput,
  type SubmitMarkInput,
} from "@ag/shared";
import { CurrentPrincipal, RequireAccess, type Principal } from "../auth/auth";
import { ZodPipe } from "../zod.pipe";
import { PerformancesService } from "./performances.service";

@Controller()
export class PerformancesController {
  constructor(private readonly performances: PerformancesService) {}

  @Post("competitions/:id/performances")
  @RequireAccess("admin")
  create(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(createPerformanceSchema)) body: CreatePerformanceInput,
  ) {
    return this.performances.create(id, body);
  }

  @Get("competitions/:id/performances")
  @RequireAccess("admin-or-judge")
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
