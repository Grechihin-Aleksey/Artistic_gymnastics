import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from "@nestjs/websockets";
import { LIVE_EVENTS, competitionRoom, panelRoom, type PerformanceView } from "@ag/shared";
import type { Server, Socket } from "socket.io";
import { z } from "zod";
import { AuthService } from "../auth/auth";
import { RelayPublisher } from "../relay/relay.publisher";

const joinSchema = z.object({ competitionId: z.uuid() });

/** Связь планшета судьи с сервером: для индикации у секретаря. */
export interface JudgePresence {
  judgeId: string;
  online: boolean;
  /** С какого момента на связи (если на связи). */
  since: string | null;
  /** Когда связь пропала последний раз (если сейчас не на связи). */
  lastSeen: string | null;
}

/**
 * Рассылка в реальном времени. Любой клиент может подписаться на соревнование
 * (табло, ретранслятор). Судья, подключившийся со своим токеном, дополнительно
 * получает оценки своей бригады.
 */
// Проверка связи раз в 10 секунд: пропавший планшет секретарь увидит примерно через 20 секунд, а не через минуту.
@WebSocketGateway({ namespace: "/live", cors: { origin: true }, pingInterval: 10_000, pingTimeout: 10_000 })
export class LiveGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() private server!: Server;
  /** Открытые подключения судей: у одного судьи может быть несколько вкладок. */
  private readonly judgeSockets = new Map<string, { sockets: Set<string>; since: Date | null; lastSeen: Date | null }>();

  constructor(
    private readonly auth: AuthService,
    private readonly relay: RelayPublisher,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const token: unknown = client.handshake.auth?.token;
    const principal = await this.auth.resolve(typeof token === "string" ? token : undefined);
    if (principal?.kind === "judge") {
      const { competitionId, apparatus } = principal.judge;
      await client.join([competitionRoom(competitionId), panelRoom(competitionId, apparatus)]);
      client.data.judgeId = principal.judge.id;
      const entry = this.judgeSockets.get(principal.judge.id) ?? { sockets: new Set(), since: null, lastSeen: null };
      if (entry.sockets.size === 0) entry.since = new Date();
      entry.sockets.add(client.id);
      this.judgeSockets.set(principal.judge.id, entry);
    }
  }

  handleDisconnect(client: Socket): void {
    const judgeId: unknown = client.data?.judgeId;
    if (typeof judgeId !== "string") return;
    const entry = this.judgeSockets.get(judgeId);
    if (!entry) return;
    entry.sockets.delete(client.id);
    if (entry.sockets.size === 0) {
      entry.since = null;
      entry.lastSeen = new Date();
    }
  }

  /** Кто из судей сейчас на связи; судья, ни разу не подключавшийся, — не на связи и без времени. */
  presence(judgeIds: string[]): JudgePresence[] {
    return judgeIds.map((judgeId) => {
      const entry = this.judgeSockets.get(judgeId);
      const online = Boolean(entry && entry.sockets.size > 0);
      return {
        judgeId,
        online,
        since: online ? (entry!.since?.toISOString() ?? null) : null,
        lastSeen: !online ? (entry?.lastSeen?.toISOString() ?? null) : null,
      };
    });
  }

  @SubscribeMessage(LIVE_EVENTS.join)
  async join(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    const parsed = joinSchema.safeParse(body);
    if (!parsed.success) return { ok: false };
    await client.join(competitionRoom(parsed.data.competitionId));
    return { ok: true };
  }

  /** Всё, что видит зал, уходит и на сайт через ретранслятор. */
  toCompetition(competitionId: string, event: string, payload: unknown): void {
    this.server?.to(competitionRoom(competitionId)).emit(event, payload);
    this.relay.notify(competitionId, event === LIVE_EVENTS.approved ? (payload as PerformanceView) : undefined);
  }

  toPanel(competitionId: string, apparatus: string, event: string, payload: unknown): void {
    this.server?.to(panelRoom(competitionId, apparatus)).emit(event, payload);
  }
}
