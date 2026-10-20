import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import {
  createCompetitionSchema,
  createGymnastSchema,
  createJudgeSchema,
  createTeamSchema,
  importGymnastsSchema,
  parseEntriesSchema,
  setLogoSchema,
  setNormativesSchema,
  setOfficialsSchema,
  setClubStandingSchema,
  type ClubStandingSettings,
  setRulesSchema,
  updateGymnastSchema,
  type CreateCompetitionInput,
  type CreateGymnastInput,
  type CreateJudgeInput,
  type CreateTeamInput,
  type ImportGymnastsInput,
  type ParseEntriesInput,
  type SetLogoInput,
  type SetNormativesInput,
  type SetOfficialsInput,
  type SetRulesInput,
  type UpdateGymnastInput,
} from "@ag/shared";
import { RequireAccess } from "../auth/auth";
import { ZodPipe } from "../zod.pipe";
import { CompetitionsService, publicCompetition } from "./competitions.service";
import { entriesTemplate, parseEntries } from "./entries";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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

  @Patch(":id/gymnasts/:gymnastId")
  @RequireAccess("admin")
  updateGymnast(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("gymnastId", ParseUUIDPipe) gymnastId: string,
    @Body(new ZodPipe(updateGymnastSchema)) body: UpdateGymnastInput,
  ) {
    return this.competitions.updateGymnast(id, gymnastId, body);
  }

  @Delete(":id/gymnasts/:gymnastId")
  @RequireAccess("admin")
  deleteGymnast(@Param("id", ParseUUIDPipe) id: string, @Param("gymnastId", ParseUUIDPipe) gymnastId: string) {
    return this.competitions.deleteGymnast(id, gymnastId);
  }

  /**
   * Заявка из Excel → текст для поля вставки списка. Ничего не сохраняет:
   * секретариат проверяет список и загружает его обычным импортом.
   */
  @Post(":id/gymnasts/parse-xlsx")
  @RequireAccess("admin")
  async parseEntries(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(parseEntriesSchema)) body: ParseEntriesInput,
  ) {
    const people = await this.competitions.listGymnasts(id);
    const nextBib = Math.max(body.nextBib ?? 1, Math.max(0, ...people.map((g) => g.bib)) + 1);
    try {
      return await parseEntries(Buffer.from(body.file, "base64"), nextBib);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  /** Бланк заявки для клубов. */
  @Get(":id/entries-template.xlsx")
  async entriesTemplate(@Res() res: Response) {
    const file = await entriesTemplate();
    res
      .status(200)
      .set({ "Content-Type": XLSX, "Content-Disposition": 'attachment; filename="entries.xlsx"' })
      .end(file);
  }

  @Get(":id/rules")
  getRules(@Param("id", ParseUUIDPipe) id: string) {
    return this.competitions.getRules(id);
  }

  @Put(":id/rules")
  @RequireAccess("admin")
  setRules(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(setRulesSchema)) body: SetRulesInput) {
    return this.competitions.setRules(id, body);
  }

  /** Главный судья и главный секретарь для подписей в протоколах. */
  @Put(":id/officials")
  @RequireAccess("admin")
  setOfficials(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(setOfficialsSchema)) body: SetOfficialsInput) {
    return this.competitions.setOfficials(id, body);
  }

  /** Общекомандный зачёт: очки за места в многоборье, на снарядах и команд. */
  @Put(":id/club-standing")
  @RequireAccess("admin")
  setClubStanding(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(setClubStandingSchema)) body: ClubStandingSettings,
  ) {
    return this.competitions.setClubStanding(id, body);
  }

  @Get(":id/normatives")
  getNormatives(@Param("id", ParseUUIDPipe) id: string) {
    return this.competitions.getNormatives(id);
  }

  @Put(":id/normatives")
  @RequireAccess("admin")
  setNormatives(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(setNormativesSchema)) body: SetNormativesInput,
  ) {
    return this.competitions.setNormatives(id, body);
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
