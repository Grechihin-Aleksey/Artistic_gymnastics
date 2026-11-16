import {
  createParamDecorator,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Request } from "express";
import { APP_CONFIG, type AppConfig } from "../config";
import { DB, type Db } from "../db/db.module";
import { adminSessions, judges } from "../db/schema";
import { hashToken, sameToken } from "./tokens";

export type JudgeRow = typeof judges.$inferSelect;

/** sessionId — вход по паролю; без него — токеном из .env. */
export type Principal = { kind: "admin"; sessionId?: string } | { kind: "judge"; judge: JudgeRow };

/** Код судьи уже открыт на другом планшете, а этот ждёт разрешения секретариата. */
export const TABLET_BUSY = "tablet-busy" as const;

export const TABLET_BUSY_MESSAGE =
  "Этот QR-код уже открыт на другом планшете. Попросите секретариат разрешить вход на этом планшете (экран «Судьи», «Связь судей»).";

/** Метка планшета из заголовка X-Device: её придумывает и хранит сам планшет. Нет метки — пустая строка. */
export function deviceOf(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 100) : "";
}

/** Кто может вызвать метод. Без декоратора метод открыт всем (например, результаты). */
export type Access = "admin" | "judge" | "admin-or-judge";
const ACCESS_KEY = "access";
export const RequireAccess = (access: Access) => SetMetadata(ACCESS_KEY, access);

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Principal => ctx.switchToHttp().getRequest().principal,
);

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Кто стоит за токеном. Код судьи работает на том планшете, где его открыли первым:
   * на любом другом — TABLET_BUSY, пока секретариат не разрешит вход.
   */
  async resolve(token: string | undefined, device = ""): Promise<Principal | typeof TABLET_BUSY | null> {
    if (!token) return null;
    if (sameToken(token, this.config.adminToken)) return { kind: "admin" };
    const [session] = await this.db
      .select({ id: adminSessions.id })
      .from(adminSessions)
      .where(and(eq(adminSessions.tokenHash, hashToken(token)), gt(adminSessions.expiresAt, new Date())));
    if (session) return { kind: "admin", sessionId: session.id };
    const [judge] = await this.db.select().from(judges).where(eq(judges.tokenHash, hashToken(token)));
    if (!judge) return null;
    const bound = await this.bindTablet(judge, device);
    return bound ? { kind: "judge", judge: bound } : TABLET_BUSY;
  }

  private async bindTablet(judge: JudgeRow, device: string): Promise<JudgeRow | null> {
    if (judge.deviceId === device) return judge;
    if (judge.deviceId === null) {
      const [row] = await this.db
        .update(judges)
        .set({ deviceId: device, pendingDeviceId: null })
        .where(and(eq(judges.id, judge.id), isNull(judges.deviceId)))
        .returning();
      if (row) return row;
      // Два планшета открыли код одновременно: первый уже привязан.
      const [fresh] = await this.db.select().from(judges).where(eq(judges.id, judge.id));
      if (!fresh) return null;
      if (fresh.deviceId === device) return fresh;
      judge = fresh;
    }
    if (judge.pendingDeviceId !== device) {
      await this.db.update(judges).set({ pendingDeviceId: device }).where(eq(judges.id, judge.id));
    }
    return null;
  }
}

export function bearer(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1];
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<Access | undefined>(ACCESS_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!access) return true;
    const req = ctx.switchToHttp().getRequest<Request & { principal?: Principal }>();
    const principal = await this.auth.resolve(bearer(req.headers.authorization), deviceOf(req.headers["x-device"]));
    if (principal === TABLET_BUSY) throw new ForbiddenException(TABLET_BUSY_MESSAGE);
    if (!principal) throw new UnauthorizedException("Нужен токен доступа");
    const allowed =
      access === "admin-or-judge" ||
      (access === "admin" && principal.kind === "admin") ||
      (access === "judge" && principal.kind === "judge");
    if (!allowed) throw new ForbiddenException("Недостаточно прав");
    req.principal = principal;
    return true;
  }
}
