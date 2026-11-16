import { Controller, Get, Param, ParseUUIDPipe } from "@nestjs/common";
import { RequireAccess } from "../auth/auth";
import { ReadinessService } from "./readiness.service";

@Controller()
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}

  /** Готовность к старту: участники, бригады, планшеты, команды, правила, сайт, копии. */
  @Get("competitions/:id/readiness")
  @RequireAccess("admin")
  check(@Param("id", ParseUUIDPipe) id: string) {
    return this.readiness.check(id);
  }
}
