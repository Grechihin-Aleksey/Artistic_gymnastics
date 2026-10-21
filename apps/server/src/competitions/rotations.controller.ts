import { Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import {
  distributeShiftsSchema,
  drawSchema,
  setRotationSchema,
  setShiftStartSchema,
  type DistributeShiftsInput,
  type DrawInput,
  type SetRotationInput,
  type SetShiftStartInput,
} from "@ag/shared";
import { RequireAccess } from "../auth/auth";
import { ZodPipe } from "../zod.pipe";
import { RotationsService } from "./rotations.service";

@Controller("competitions/:id")
export class RotationsController {
  constructor(private readonly rotations: RotationsService) {}

  @Get("rotation")
  view(@Param("id", ParseUUIDPipe) id: string) {
    return this.rotations.view(id);
  }

  @Post("rotation")
  @RequireAccess("admin")
  setRotation(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(setRotationSchema)) body: SetRotationInput) {
    return this.rotations.setRotation(id, body);
  }

  @Get("draw")
  @RequireAccess("admin")
  drawView(@Param("id", ParseUUIDPipe) id: string) {
    return this.rotations.drawView(id);
  }

  @Post("draw")
  @RequireAccess("admin")
  draw(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(drawSchema)) body: DrawInput) {
    return this.rotations.draw(id, body);
  }

  @Post("shifts/distribute")
  @RequireAccess("admin")
  distribute(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(distributeShiftsSchema)) body: DistributeShiftsInput) {
    return this.rotations.distribute(id, body);
  }

  @Put("shifts/:number")
  @RequireAccess("admin")
  setStart(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("number", ParseIntPipe) number: number,
    @Body(new ZodPipe(setShiftStartSchema)) body: SetShiftStartInput,
  ) {
    return this.rotations.setStart(id, number, body);
  }
}
