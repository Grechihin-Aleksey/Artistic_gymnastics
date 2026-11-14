import { Body, Controller, Param, ParseUUIDPipe, Put } from "@nestjs/common";
import { LIVE_EVENTS, setBoardSwitchSchema, type SetBoardSwitchInput } from "@ag/shared";
import { RequireAccess } from "../auth/auth";
import { LiveGateway } from "../live/live.gateway";
import { ZodPipe } from "../zod.pipe";
import { CompetitionsService } from "./competitions.service";

/** Табло турнира из двух частей: секретариат включает чередование или выводит нужную часть. */
@Controller("competitions/:id/board-switch")
export class BoardSwitchController {
  constructor(
    private readonly competitions: CompetitionsService,
    private readonly live: LiveGateway,
  ) {}

  @Put()
  @RequireAccess("admin")
  async set(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(setBoardSwitchSchema)) body: SetBoardSwitchInput) {
    const { boardSwitch, parts } = await this.competitions.setBoardSwitch(id, body);
    for (const part of parts) this.live.toCompetition(part, LIVE_EVENTS.boardSwitch, boardSwitch);
    return { boardSwitch };
  }
}
