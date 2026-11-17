import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { siteCardSchema, type SiteCardInput } from "@ag/shared";
import { RequireAccess } from "../auth/auth";
import { ZodPipe } from "../zod.pipe";
import { SiteCardService } from "./site-card.service";

/** Карточка соревнования на сайте федерации: посмотреть и «Подключить к сайту». */
@Controller("competitions/:id/site-card")
@RequireAccess("admin")
export class SiteCardController {
  constructor(private readonly cards: SiteCardService) {}

  @Get()
  view(@Param("id", ParseUUIDPipe) id: string) {
    return this.cards.view(id);
  }

  @Post()
  publish(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(siteCardSchema)) body: SiteCardInput) {
    return this.cards.publish(id, body);
  }
}
