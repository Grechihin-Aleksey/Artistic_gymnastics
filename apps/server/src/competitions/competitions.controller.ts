import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import {
  createCompetitionSchema,
  createGymnastSchema,
  createJudgeSchema,
  createTeamSchema,
  type CreateCompetitionInput,
  type CreateGymnastInput,
  type CreateJudgeInput,
  type CreateTeamInput,
} from "@ag/shared";
import { RequireAccess } from "../auth/auth";
import { ZodPipe } from "../zod.pipe";
import { CompetitionsService } from "./competitions.service";

@Controller("competitions")
export class CompetitionsController {
  constructor(private readonly competitions: CompetitionsService) {}

  @Post()
  @RequireAccess("admin")
  create(@Body(new ZodPipe(createCompetitionSchema)) body: CreateCompetitionInput) {
    return this.competitions.create(body);
  }

  @Get()
  list() {
    return this.competitions.list();
  }

  @Get(":id")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.competitions.get(id);
  }

  @Post(":id/teams")
  @RequireAccess("admin")
  addTeam(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(createTeamSchema)) body: CreateTeamInput) {
    return this.competitions.addTeam(id, body);
  }

  @Get(":id/teams")
  listTeams(@Param("id", ParseUUIDPipe) id: string) {
    return this.competitions.listTeams(id);
  }

  @Post(":id/gymnasts")
  @RequireAccess("admin")
  addGymnast(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(createGymnastSchema)) body: CreateGymnastInput,
  ) {
    return this.competitions.addGymnast(id, body);
  }

  @Get(":id/gymnasts")
  listGymnasts(@Param("id", ParseUUIDPipe) id: string) {
    return this.competitions.listGymnasts(id);
  }

  @Post(":id/judges")
  @RequireAccess("admin")
  addJudge(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(createJudgeSchema)) body: CreateJudgeInput) {
    return this.competitions.addJudge(id, body);
  }

  @Get(":id/judges")
  @RequireAccess("admin")
  listJudges(@Param("id", ParseUUIDPipe) id: string) {
    return this.competitions.listJudges(id);
  }
}
