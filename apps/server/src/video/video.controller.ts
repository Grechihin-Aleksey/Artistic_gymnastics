import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { apparatusSchema, setVideoCamerasSchema, type SetVideoCamerasInput } from "@ag/shared";
import { RequireAccess } from "../auth/auth";
import { ZodPipe } from "../zod.pipe";
import { VideoService } from "./video.service";

/** Видеоповторы: камеры на снарядах настраивает и ролики смотрит секретариат (и главный судья на его вкладке). */
@Controller()
export class VideoController {
  constructor(private readonly video: VideoService) {}

  @Get("video")
  @RequireAccess("admin")
  status() {
    return this.video.status();
  }

  @Put("video/cameras")
  @RequireAccess("admin")
  setCameras(@Body(new ZodPipe(setVideoCamerasSchema)) body: SetVideoCamerasInput) {
    return this.video.setCameras(body);
  }

  @Get("video/cameras/:apparatus/snapshot")
  @RequireAccess("admin")
  async snapshot(@Param("apparatus", new ZodPipe(apparatusSchema)) apparatus: string, @Res() res: Response) {
    const jpeg = await this.video.snapshot(apparatus);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    res.end(jpeg);
  }

  @Get("performances/:id/replay")
  @RequireAccess("admin")
  replay(@Param("id", ParseUUIDPipe) id: string) {
    return this.video.replay(id);
  }

  @Post("performances/:id/replay/wide")
  @RequireAccess("admin")
  replayWide(@Param("id", ParseUUIDPipe) id: string) {
    return this.video.replayWide(id);
  }

  @Get("competitions/:id/replays")
  @RequireAccess("admin")
  clips(@Param("id", ParseUUIDPipe) id: string) {
    return this.video.clipsOf(id);
  }

  @Delete("competitions/:id/replays")
  @RequireAccess("admin")
  removeClips(@Param("id", ParseUUIDPipe) id: string) {
    return this.video.removeClips(id);
  }

  /** Сам ролик: по подписанной ссылке из /performances/:id/replay, с перемоткой (Range). */
  @Get("video/clips/:name")
  async clip(@Param("name") name: string, @Query("exp") exp: string, @Query("sig") sig: string, @Res() res: Response) {
    const file = await this.video.clipPath(name, exp, sig);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(file, { headers: { "Content-Type": "video/mp4" } });
  }
}
