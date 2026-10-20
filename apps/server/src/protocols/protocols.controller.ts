import { Controller, Get, Param, ParseUUIDPipe, Query, Res } from "@nestjs/common";
import type { Apparatus } from "@ag/scoring";
import { apparatusSchema } from "@ag/shared";
import type { Response } from "express";
import { z } from "zod";
import { RequireAccess } from "../auth/auth";
import { ZodPipe } from "../zod.pipe";
import { categoryQuery } from "../results/results.controller";
import type { CategoryScope } from "../results/results.service";
import { ProtocolsService } from "./protocols.service";

/** Протоколы с оценками каждого судьи печатает секретариат. */
@Controller("competitions/:id/protocols")
@RequireAccess("admin")
export class ProtocolsController {
  constructor(private readonly protocols: ProtocolsService) {}

  @Get("apparatus/:apparatus")
  async apparatus(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("apparatus", new ZodPipe(apparatusSchema)) apparatus: Apparatus,
    @Query("category", categoryQuery) category: CategoryScope,
    @Res() res: Response,
  ) {
    send(res, await this.protocols.apparatus(id, apparatus, category), `protocol-${apparatus}.pdf`);
  }

  @Get("all-around")
  async allAround(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("category", categoryQuery) category: CategoryScope,
    @Res() res: Response,
  ) {
    send(res, await this.protocols.allAround(id, category), "protocol-all-around.pdf");
  }

  @Get("results.xlsx")
  async workbook(@Param("id", ParseUUIDPipe) id: string, @Res() res: Response) {
    const xlsx = await this.protocols.workbook(id);
    res
      .status(200)
      .set({
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="results.xlsx"',
        "Cache-Control": "no-store",
      })
      .end(xlsx);
  }

  @Get("start-list")
  async startList(@Param("id", ParseUUIDPipe) id: string, @Res() res: Response) {
    send(res, await this.protocols.startList(id), "start-list.pdf");
  }

  @Get("sheet/:apparatus")
  async sheet(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("apparatus", new ZodPipe(apparatusSchema)) apparatus: Apparatus,
    @Res() res: Response,
  ) {
    send(res, await this.protocols.apparatusSheet(id, apparatus), `sheet-${apparatus}.pdf`);
  }

  /** Грамоты призёрам: ?kind=all-around (многоборье и команды) или apparatus, ?places=3. */
  @Get("diplomas")
  async diplomas(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("kind", new ZodPipe(z.enum(["all-around", "apparatus"]).default("all-around")))
    kind: "all-around" | "apparatus",
    @Query("places", new ZodPipe(z.coerce.number().int().min(1).max(10).default(3))) places: number,
    @Res() res: Response,
  ) {
    send(res, await this.protocols.diplomas(id, kind, places), "diplomas.pdf");
  }

  @Get("teams")
  async teams(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("category", categoryQuery) category: CategoryScope,
    @Res() res: Response,
  ) {
    send(res, await this.protocols.teams(id, category), "protocol-teams.pdf");
  }
}

function send(res: Response, pdf: Buffer, filename: string): void {
  res
    .status(200)
    .set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store",
    })
    .end(pdf);
}
