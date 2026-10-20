import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { RequireAccess } from "../auth/auth";
import { TransferService } from "./transfer.service";

/** Файл турнира для переноса на другой компьютер и удаление турнира. */
@Controller("competitions")
export class TransferController {
  constructor(private readonly transfer: TransferService) {}

  @Get(":id/export")
  @RequireAccess("admin")
  async export(@Param("id", ParseUUIDPipe) id: string, @Res() res: Response) {
    const file = await this.transfer.export(id);
    const date = file.exportedAt.slice(0, 10);
    res
      .status(200)
      .set({
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="competition-${date}.json"`,
        "Cache-Control": "no-store",
      })
      .end(JSON.stringify(file));
  }

  @Post("import")
  @RequireAccess("admin")
  import(@Body() body: unknown) {
    return this.transfer.import(body);
  }

  @Delete(":id")
  @RequireAccess("admin")
  @HttpCode(204)
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    await this.transfer.remove(id);
  }
}
