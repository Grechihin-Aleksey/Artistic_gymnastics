import { Body, Controller, Delete, ForbiddenException, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { updateJudgeSchema, type UpdateJudgeInput } from "@ag/shared";
import { AllowChief, CurrentPrincipal, RequireAccess, type Principal } from "../auth/auth";
import { LiveGateway } from "../live/live.gateway";
import { ZodPipe } from "../zod.pipe";
import { CompetitionsService, publicCompetition, withoutSecrets } from "./competitions.service";

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

  /** QR-коды всех судей для печати: без перевыпуска, прежние коды продолжают работать. */
  @Get("competitions/:id/judges/codes")
  @RequireAccess("admin")
  codes(@Param("id", ParseUUIDPipe) id: string) {
    return this.competitions.judgeCodes(id);
  }

  /** Код главного судьи для отдельного ПК или планшета: показать или перепечатать QR. */
  @Get("competitions/:id/chief-code")
  @RequireAccess("admin")
  chiefCode(@Param("id", ParseUUIDPipe) id: string) {
    return this.competitions.chiefCode(id);
  }

  /** Новый код главного судьи; прежний перестаёт работать. */
  @Post("competitions/:id/chief-code")
  @RequireAccess("admin")
  newChiefCode(@Param("id", ParseUUIDPipe) id: string) {
    return this.competitions.newChiefCode(id);
  }

  /** Экран главного судьи узнаёт по коду свой турнир (у турнира из двух частей — обе части). */
  @Get("chief/me")
  @RequireAccess("admin")
  @AllowChief()
  async chiefMe(@CurrentPrincipal() principal: Principal) {
    if (principal.kind !== "chief") throw new ForbiddenException("Это код не главного судьи");
    const parts = await Promise.all(principal.competitionIds.map((id) => this.competitions.get(id)));
    return { competitionId: principal.competitionId, competitions: parts.map(publicCompetition) };
  }

  /** Страница судьи узнаёт по токену, кто она и на каком снаряде. */
  @Get("me")
  @RequireAccess("judge")
  async me(@CurrentPrincipal() principal: Principal) {
    if (principal.kind !== "judge") throw new Error("unreachable");
    const judge = withoutSecrets(principal.judge);
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

  /** Код судьи открыт на одном планшете; на другом он заработает только после этого разрешения. */
  @Post("judges/:id/allow-tablet")
  @RequireAccess("admin")
  allowTablet(@Param("id", ParseUUIDPipe) id: string) {
    return this.competitions.allowTablet(id);
  }

  @Post("judges/:id/token")
  @RequireAccess("admin")
  reissueToken(@Param("id", ParseUUIDPipe) id: string) {
    return this.competitions.reissueJudgeToken(id);
  }
}
