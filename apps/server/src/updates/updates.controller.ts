import { Controller, Get, Post } from "@nestjs/common";
import { RequireAccess } from "../auth/auth";
import { UpdatesService } from "./updates.service";

@Controller("updates")
@RequireAccess("admin")
export class UpdatesController {
  constructor(private readonly updates: UpdatesService) {}

  @Get()
  status() {
    return this.updates.status();
  }

  /** «Проверить сейчас» в секретариате. */
  @Post("check")
  check() {
    return this.updates.check();
  }
}
