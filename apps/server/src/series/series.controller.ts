import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Res } from "@nestjs/common";
import { seriesSchema, type SeriesInput } from "@ag/shared";
import type { Response } from "express";
import { RequireAccess } from "../auth/auth";
import { ProtocolsService } from "../protocols/protocols.service";
import { ZodPipe } from "../zod.pipe";
import { SeriesService } from "./series.service";

/** Кубки из нескольких этапов: итоги открыты всем, настройка — секретариату. */
@Controller("series")
export class SeriesController {
  constructor(
    private readonly series: SeriesService,
    private readonly protocols: ProtocolsService,
  ) {}

  @Get()
  list() {
    return this.series.list();
  }

  @Post()
  @RequireAccess("admin")
  create(@Body(new ZodPipe(seriesSchema)) body: SeriesInput) {
    return this.series.create(body);
  }

  @Put(":id")
  @RequireAccess("admin")
  update(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(seriesSchema)) body: SeriesInput) {
    return this.series.update(id, body);
  }

  @Delete(":id")
  @RequireAccess("admin")
  remove(@Param("id", ParseUUIDPipe) id: string) {
    return this.series.remove(id);
  }

  @Get(":id/standings")
  standings(@Param("id", ParseUUIDPipe) id: string) {
    return this.series.standings(id);
  }

  @Get(":id/protocol")
  @RequireAccess("admin")
  async protocol(@Param("id", ParseUUIDPipe) id: string, @Res() res: Response) {
    const pdf = await this.protocols.series(await this.series.standings(id));
    res.status(200).set({ "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="series.pdf"', "Cache-Control": "no-store" }).end(pdf);
  }
}
