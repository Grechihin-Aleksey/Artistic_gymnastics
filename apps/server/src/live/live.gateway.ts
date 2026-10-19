import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
} from "@nestjs/websockets";
import { LIVE_EVENTS, competitionRoom, panelRoom, type PerformanceView } from "@ag/shared";
import type { Server, Socket } from "socket.io";
import { z } from "zod";
import { AuthService } from "../auth/auth";
import { RelayPublisher } from "../relay/relay.publisher";

const joinSchema = z.object({ competitionId: z.uuid() });

/**
 * Рассылка в реальном времени. Любой клиент может подписаться на соревнование
 * (табло, ретранслятор). Судья, подключившийся со своим токеном, дополнительно
 * получает оценки своей бригады.
 */
@WebSocketGateway({ namespace: "/live", cors: { origin: true } })
export class LiveGateway implements OnGatewayConnection {
  @WebSocketServer() private server!: Server;

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
    }
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
