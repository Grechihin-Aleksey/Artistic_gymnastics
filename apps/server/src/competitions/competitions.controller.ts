import { Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  createCompetitionSchema,
  createGymnastSchema,
  createJudgeSchema,
  createTeamSchema,
  importGymnastsSchema,
  setLogoSchema,
  type CreateCompetitionInput,
  type CreateGymnastInput,
  type CreateJudgeInput,
  type CreateTeamInput,
  type ImportGymnastsInput,
  type SetLogoInput,
} from "@ag/shared";
import { RequireAccess } from "../auth/auth";
import { ZodPipe } from "../zod.pipe";
import { CompetitionsService, publicCompetition } from "./competitions.service";

@Controller("competitions")
export class CompetitionsController {
  constructor(private readonly competitions: CompetitionsService) {}

  @Post()
  @RequireAccess("admin")
  async create(@Body(new ZodPipe(createCompetitionSchema)) body: CreateCompetitionInput) {
    return publicCompetition(await this.competitions.create(body));
  }

  @Get()
  async list() {
    return (await this.competitions.list()).map(publicCompetition);
  }

  @Get(":id")
  async get(@Param("id", ParseUUIDPipe) id: string) {
    return publicCompetition(await this.competitions.get(id));
  }

  /** Логотип открыт всем: его показывают протоколы и, при желании, сайт. */
  @Get(":id/logo")
  async logo(@Param("id", ParseUUIDPipe) id: string, @Res() res: Response) {
    const { logo } = await this.competitions.get(id);
    if (!logo) throw new NotFoundException("Логотип не загружен");
    const [, type, base64] = /^data:(image\/(?:png|jpeg));base64,(.*)$/.exec(logo)!;
    res.status(200).set({ "Content-Type": type!, "Cache-Control": "no-cache" }).end(Buffer.from(base64!, "base64"));
  }

  @Put(":id/logo")
  @RequireAccess("admin")
  setLogo(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(setLogoSchema)) body: SetLogoInput) {
    return this.competitions.setLogo(id, body.dataUrl);
  }

  @Delete(":id/logo")
  @RequireAccess("admin")
  removeLogo(@Param("id", ParseUUIDPipe) id: string) {
    return this.competitions.setLogo(id, null);
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

  @Post(":id/gymnasts/import")
  @RequireAccess("admin")
  importGymnasts(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(importGymnastsSchema)) body: ImportGymnastsInput,
  ) {
    return this.competitions.importGymnasts(id, body);
  }

  @Get(":id/categories")
  listCategories(@Param("id", ParseUUIDPipe) id: string) {
    return this.competitions.listCategories(id);
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
