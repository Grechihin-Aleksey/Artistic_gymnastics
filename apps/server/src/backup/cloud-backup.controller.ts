import { Controller, Get, HttpCode, Post } from "@nestjs/common";
import { RequireAccess } from "../auth/auth";
import { CloudBackupService } from "./cloud-backup.service";

/** Состояние копии в облако и отправка по кнопке. */
@Controller("cloud-backup")
export class CloudBackupController {
  constructor(private readonly backup: CloudBackupService) {}

  @Get()
  @RequireAccess("admin")
  status() {
    return this.backup.status();
  }

  @Post()
  @RequireAccess("admin")
  @HttpCode(200)
  async runNow() {
    await this.backup.run();
    return this.backup.status();
  }
}
