import { Body, Controller, Get, Put } from "@nestjs/common";
import { z } from "zod";
import { RequireAccess } from "../auth/auth";
import { ZodPipe } from "../zod.pipe";
import { LicenseService } from "./license.service";

const keySchema = z.object({ key: z.string().min(1, "Вставьте ключ лицензии").max(5000) });

@Controller("license")
export class LicenseController {
  constructor(private readonly licenses: LicenseService) {}

  @Get()
  @RequireAccess("admin")
  status() {
    return this.licenses.status();
  }

  @Put()
  @RequireAccess("admin")
  save(@Body(new ZodPipe(keySchema)) body: { key: string }) {
    return this.licenses.save(body.key);
  }
}
