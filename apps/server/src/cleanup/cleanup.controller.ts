import { Body, Controller, Get, HttpCode, Post, Put } from "@nestjs/common";
import { setCleanupSchema, type SetCleanupInput } from "@ag/shared";
import { RequireAccess } from "../auth/auth";
import { ZodPipe } from "../zod.pipe";
import { CleanupService } from "./cleanup.service";

/** Очистка после турниров: срок, что лежит и кнопка «Очистить сейчас». */
@Controller("cleanup")
@RequireAccess("admin")
export class CleanupController {
  constructor(private readonly cleanup: CleanupService) {}

  @Get()
  status() {
    return this.cleanup.status();
  }

  @Put()
  set(@Body(new ZodPipe(setCleanupSchema)) body: SetCleanupInput) {
    return this.cleanup.setDays(body.days);
  }

  @Post("run")
  @HttpCode(200)
  run() {
    return this.cleanup.runNow();
  }
}
