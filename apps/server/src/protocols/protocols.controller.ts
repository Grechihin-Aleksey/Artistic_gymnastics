import { Controller, Get, Param, ParseUUIDPipe, Res } from "@nestjs/common";
import type { Apparatus } from "@ag/scoring";
import { apparatusSchema } from "@ag/shared";
import type { Response } from "express";
import { RequireAccess } from "../auth/auth";
import { ZodPipe } from "../zod.pipe";
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
    @Res() res: Response,
  ) {
    send(res, await this.protocols.apparatus(id, apparatus), `protocol-${apparatus}.pdf`);
  }

  @Get("all-around")
  async allAround(@Param("id", ParseUUIDPipe) id: string, @Res() res: Response) {
    send(res, await this.protocols.allAround(id), "protocol-all-around.pdf");
  }

  @Get("teams")
  async teams(@Param("id", ParseUUIDPipe) id: string, @Res() res: Response) {
    send(res, await this.protocols.teams(id), "protocol-teams.pdf");
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
