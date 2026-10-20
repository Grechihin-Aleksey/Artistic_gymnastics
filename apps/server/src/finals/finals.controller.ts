import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import {
  apparatusSchema,
  createFinalsSchema,
  replaceFinalistSchema,
  setPhaseSchema,
  type CreateFinalsInput,
  type ReplaceFinalistInput,
  type SetPhaseInput,
} from "@ag/shared";
import type { Apparatus } from "@ag/scoring";
import { RequireAccess } from "../auth/auth";
import { ZodPipe } from "../zod.pipe";
import { FinalsService } from "./finals.service";

/** Состав финалов открыт всем: его читают планшеты судей и табло. */
@Controller("competitions/:id/finals")
export class FinalsController {
  constructor(private readonly finals: FinalsService) {}

  @Get()
  view(@Param("id", ParseUUIDPipe) id: string) {
    return this.finals.view(id);
  }

  @Post()
  @RequireAccess("admin")
  create(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(createFinalsSchema)) body: CreateFinalsInput) {
    return this.finals.create(id, body);
  }

  @Post("phase")
  @RequireAccess("admin")
  setPhase(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(setPhaseSchema)) body: SetPhaseInput) {
    return this.finals.setPhase(id, body);
  }

  @Post(":apparatus/replace")
  @RequireAccess("admin")
  replace(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("apparatus", new ZodPipe(apparatusSchema)) apparatus: Apparatus,
    @Body(new ZodPipe(replaceFinalistSchema)) body: ReplaceFinalistInput,
  ) {
    return this.finals.replace(id, apparatus, body);
  }
}
