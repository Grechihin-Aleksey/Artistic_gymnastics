import { Controller, Delete, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { RequireAccess } from "../auth/auth";
import { SiteProtocolsService } from "./site-protocols.service";

/** Выкладывает итоговые протоколы на сайт соревнований и снимает их. */
@Controller("competitions/:id/site-protocols")
@RequireAccess("admin")
export class SiteProtocolsController {
  constructor(private readonly site: SiteProtocolsService) {}

  @Get()
  view(@Param("id", ParseUUIDPipe) id: string) {
    return this.site.view(id);
  }

  @Post()
  publish(@Param("id", ParseUUIDPipe) id: string) {
    return this.site.publish(id);
  }

  @Delete()
  unpublish(@Param("id", ParseUUIDPipe) id: string) {
    return this.site.unpublish(id);
  }
}
