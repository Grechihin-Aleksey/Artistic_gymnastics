import { Controller, Get, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { apparatusSchema } from "@ag/shared";
import type { Apparatus } from "@ag/scoring";
import { z } from "zod";
import { ZodPipe } from "../zod.pipe";
import { ResultsService, type VaultMode } from "./results.service";

/** Результаты открыты всем: их читают табло в зале и ретранслятор для сайта. */
@Controller("competitions/:id/results")
export class ResultsController {
  constructor(private readonly results: ResultsService) {}

  @Get("apparatus/:apparatus")
  apparatus(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("apparatus", new ZodPipe(apparatusSchema)) apparatus: Apparatus,
    @Query("vault", new ZodPipe(z.enum(["first", "average"]).default("average"))) vault: VaultMode,
  ) {
    return this.results.apparatus(id, apparatus, vault);
  }

  @Get("all-around")
  allAround(@Param("id", ParseUUIDPipe) id: string) {
    return this.results.allAround(id);
  }

  @Get("teams")
  teams(@Param("id", ParseUUIDPipe) id: string) {
    return this.results.teams(id);
  }
}
