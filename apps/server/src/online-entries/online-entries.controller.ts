import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import {
  rejectOnlineEntrySchema,
  setOnlineEntriesSchema,
  type RejectOnlineEntryInput,
  type SetOnlineEntriesInput,
} from "@ag/shared";
import { RequireAccess } from "../auth/auth";
import { ZodPipe } from "../zod.pipe";
import { OnlineEntriesService } from "./online-entries.service";

/** Онлайн-заявки клубов видит и разбирает только секретариат. */
@Controller("competitions/:id/online-entries")
@RequireAccess("admin")
export class OnlineEntriesController {
  constructor(private readonly entries: OnlineEntriesService) {}

  @Get()
  view(@Param("id", ParseUUIDPipe) id: string) {
    return this.entries.view(id);
  }

  @Put("settings")
  settings(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(setOnlineEntriesSchema)) body: SetOnlineEntriesInput) {
    return this.entries.setSettings(id, body);
  }

  @Post("sync")
  sync(@Param("id", ParseUUIDPipe) id: string) {
    return this.entries.sync(id);
  }

  @Post(":entryId/accept")
  accept(@Param("id", ParseUUIDPipe) id: string, @Param("entryId", ParseUUIDPipe) entryId: string) {
    return this.entries.accept(id, entryId);
  }

  @Post(":entryId/reject")
  reject(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("entryId", ParseUUIDPipe) entryId: string,
    @Body(new ZodPipe(rejectOnlineEntrySchema)) body: RejectOnlineEntryInput,
  ) {
    return this.entries.reject(id, entryId, body);
  }
}
