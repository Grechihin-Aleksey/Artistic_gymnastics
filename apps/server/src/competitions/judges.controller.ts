import { Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { CurrentPrincipal, RequireAccess, type Principal } from "../auth/auth";
import { LiveGateway } from "../live/live.gateway";
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

  @Post("judges/:id/token")
  @RequireAccess("admin")
  reissueToken(@Param("id", ParseUUIDPipe) id: string) {
    return this.competitions.reissueJudgeToken(id);
  }
}
