import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { updateJudgeSchema, type UpdateJudgeInput } from "@ag/shared";
import { CurrentPrincipal, RequireAccess, type Principal } from "../auth/auth";
import { LiveGateway } from "../live/live.gateway";
import { ZodPipe } from "../zod.pipe";
import { CompetitionsService, publicCompetition } from "./competitions.service";

@Controller()
export class JudgesController {
  constructor(
    private readonly competitions: CompetitionsService,
    private readonly live: LiveGateway,
  ) {}

  /** Секретариат видит, чьи планшеты на связи с сервером. */
  @Get("competitions/:id/judges/presence")
  @RequireAccess("admin")
  async presence(@Param("id", ParseUUIDPipe) id: string) {
    const judges = await this.competitions.listJudges(id);
    return this.live.presence(judges.map((j) => j.id));
  }

  /** Страница судьи узнаёт по токену, кто она и на каком снаряде. */
  @Get("me")
  @RequireAccess("judge")
  async me(@CurrentPrincipal() principal: Principal) {
    if (principal.kind !== "judge") throw new Error("unreachable");
    const { tokenHash: _, ...judge } = principal.judge;
    return {
      judge,
      competition: publicCompetition(await this.competitions.get(judge.competitionId)),
      panel: await this.competitions.panel(judge.competitionId, judge.apparatus),
    };
  }

  @Patch("judges/:id")
  @RequireAccess("admin")
  update(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(updateJudgeSchema)) body: UpdateJudgeInput) {
    return this.competitions.updateJudge(id, body);
  }

  @Delete("judges/:id")
  @RequireAccess("admin")
  remove(@Param("id", ParseUUIDPipe) id: string) {
    return this.competitions.removeJudge(id);
  }

  @Post("judges/:id/token")
  @RequireAccess("admin")
  reissueToken(@Param("id", ParseUUIDPipe) id: string) {
    return this.competitions.reissueJudgeToken(id);
  }
}
