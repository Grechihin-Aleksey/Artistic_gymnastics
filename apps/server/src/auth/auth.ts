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
import { eq } from "drizzle-orm";
import type { Request } from "express";
import { APP_CONFIG, type AppConfig } from "../config";
import { DB, type Db } from "../db/db.module";
import { judges } from "../db/schema";
import { hashToken, sameToken } from "./tokens";

export type JudgeRow = typeof judges.$inferSelect;

export type Principal = { kind: "admin" } | { kind: "judge"; judge: JudgeRow };

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

  async resolve(token: string | undefined): Promise<Principal | null> {
    if (!token) return null;
    if (sameToken(token, this.config.adminToken)) return { kind: "admin" };
    const [judge] = await this.db.select().from(judges).where(eq(judges.tokenHash, hashToken(token)));
    return judge ? { kind: "judge", judge } : null;
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
    const principal = await this.auth.resolve(bearer(req.headers.authorization));
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
