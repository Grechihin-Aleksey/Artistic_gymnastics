import { BadGatewayException, Controller, Get, Inject, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { RequireAccess } from "../auth/auth";
import { CompetitionsService } from "../competitions/competitions.service";
import { APP_CONFIG, type AppConfig } from "../config";
import { RelayPublisher, type RelayStatus } from "./relay.publisher";

interface SiteView extends RelayStatus {
  /** Страница табло соревнования на сайте. */
  page: string | null;
  /** Код для вставки на страницу сайта. */
  embed: string | null;
}

/** Связь зала с сайтом: состояние для секретариата и отправка соревнования на сайт сразу. */
@Controller()
@RequireAccess("admin")
export class SiteController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly relay: RelayPublisher,
    private readonly competitions: CompetitionsService,
  ) {}

  @Get("site")
  overall(): RelayStatus {
    return this.relay.status();
  }

  @Get("competitions/:id/site")
  async view(@Param("id", ParseUUIDPipe) id: string): Promise<SiteView> {
    await this.competitions.get(id);
    return this.withLinks(id, this.relay.status(id));
  }

  @Post("competitions/:id/site")
  async publish(@Param("id", ParseUUIDPipe) id: string): Promise<SiteView> {
    await this.competitions.get(id);
    try {
      return this.withLinks(id, await this.relay.publishNow(id));
    } catch (e) {
      throw new BadGatewayException(`Не удалось отправить на сайт: ${(e as Error).message}`);
    }
  }

  private withLinks(id: string, status: RelayStatus): SiteView {
    if (!status.enabled || !this.config.relayUrl) return { ...status, page: null, embed: null };
    const base = this.config.relayUrl.replace(/\/+$/, "");
    return {
      ...status,
      page: `${base}/widget/index.html#c=${id}&view=auto&theme=dark`,
      embed: `<div data-ag-results="${id}" data-view="auto" data-theme="dark"></div>\n<script src="${base}/embed.js" async></script>`,
    };
  }
}
