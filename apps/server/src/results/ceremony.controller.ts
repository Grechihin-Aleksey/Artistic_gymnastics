import { Body, Controller, Param, ParseUUIDPipe, Put } from "@nestjs/common";
import { LIVE_EVENTS, setCeremonySchema, type SetCeremonyInput } from "@ag/shared";
import { RequireAccess } from "../auth/auth";
import { LiveGateway } from "../live/live.gateway";
import { ZodPipe } from "../zod.pipe";
import { ResultsService } from "./results.service";

/** Награждение на табло: секретариат выводит пьедестал и убирает его. */
@Controller("competitions/:id/ceremony")
export class CeremonyController {
  constructor(
    private readonly results: ResultsService,
    private readonly live: LiveGateway,
  ) {}

  @Put()
  @RequireAccess("admin")
  async set(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(setCeremonySchema)) body: SetCeremonyInput) {
    const view = await this.results.setCeremony(id, body.ceremony);
    this.live.toCompetition(id, LIVE_EVENTS.ceremony, view);
    return { ceremony: view };
  }
}
