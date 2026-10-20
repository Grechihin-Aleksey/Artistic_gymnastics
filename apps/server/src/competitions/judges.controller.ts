import { Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { CurrentPrincipal, RequireAccess, type Principal } from "../auth/auth";
import { CompetitionsService, publicCompetition } from "./competitions.service";

@Controller()
export class JudgesController {
  constructor(private readonly competitions: CompetitionsService) {}

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

  @Post("judges/:id/token")
  @RequireAccess("admin")
  reissueToken(@Param("id", ParseUUIDPipe) id: string) {
    return this.competitions.reissueJudgeToken(id);
  }
}
