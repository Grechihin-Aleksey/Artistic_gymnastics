import { Controller, Get, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { apparatusSchema, type Stage } from "@ag/shared";
import type { Apparatus } from "@ag/scoring";
import { z } from "zod";
import { ZodPipe } from "../zod.pipe";
import { ResultsService, type CategoryScope, type VaultMode } from "./results.service";

/** ?category=<id> — один разряд, ?category=none — участники без разряда, без параметра — все. */
export const categoryQuery = new ZodPipe(
  z
    .union([z.uuid(), z.literal("none")])
    .optional()
    .transform((v): CategoryScope => (v === "none" ? null : v)),
);

/** ?stage=final — финал на снаряде, без параметра — квалификация. */
export const stageQuery = new ZodPipe(
  z
    .enum(["qual", "final"])
    .default("qual")
    .transform((v): Stage => (v === "final" ? "FINAL" : "QUAL")),
);

/** Результаты открыты всем: их читают табло в зале и ретранслятор для сайта. */
@Controller("competitions/:id/results")
export class ResultsController {
  constructor(private readonly results: ResultsService) {}

  @Get("snapshot")
  snapshot(@Param("id", ParseUUIDPipe) id: string) {
    return this.results.snapshot(id);
  }

  @Get("categories")
  categories(@Param("id", ParseUUIDPipe) id: string) {
    return this.results.categoryList(id);
  }

  @Get("live")
  live(@Param("id", ParseUUIDPipe) id: string) {
    return this.results.live(id);
  }

  @Get("apparatus/:apparatus")
  apparatus(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("apparatus", new ZodPipe(apparatusSchema)) apparatus: Apparatus,
    @Query("vault", new ZodPipe(z.enum(["first", "average"]).default("average"))) vault: VaultMode,
    @Query("category", categoryQuery) category: CategoryScope,
    @Query("stage", stageQuery) stage: Stage,
  ) {
    return this.results.apparatus(id, apparatus, vault, category, stage);
  }

  @Get("all-around")
  allAround(@Param("id", ParseUUIDPipe) id: string, @Query("category", categoryQuery) category: CategoryScope) {
    return this.results.allAround(id, category);
  }

  @Get("teams")
  teams(@Param("id", ParseUUIDPipe) id: string, @Query("category", categoryQuery) category: CategoryScope) {
    return this.results.teams(id, category);
  }
}
