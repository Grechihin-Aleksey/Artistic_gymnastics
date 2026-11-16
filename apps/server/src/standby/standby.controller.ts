import { BadRequestException, Body, Controller, Get, Post, Put } from "@nestjs/common";
import { setStandbySchema, type SetStandbyInput } from "@ag/shared";
import { RequireAccess } from "../auth/auth";
import { ZodPipe } from "../zod.pipe";
import { StandbyService } from "./standby.service";

/** Запасной ноутбук: адрес основного, копии турниров и «Продолжить на этом ноутбуке». */
@Controller("standby")
@RequireAccess("admin")
export class StandbyController {
  constructor(private readonly standby: StandbyService) {}

  @Get()
  status() {
    return this.standby.status();
  }

  @Put()
  async set(@Body(new ZodPipe(setStandbySchema)) body: SetStandbyInput) {
    if (!body.primaryUrl) return this.standby.disable();
    try {
      return await this.standby.configure(body.primaryUrl, body.token ?? "");
    } catch (e) {
      throw new BadRequestException(`Резерв не включён: ${(e as Error).message}`);
    }
  }

  @Post("sync")
  async sync() {
    await this.standby.sync();
    return this.standby.status();
  }

  @Post("take-over")
  async takeOver() {
    try {
      return await this.standby.takeOver();
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }
}
