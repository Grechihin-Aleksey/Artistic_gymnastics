import { Body, Controller, Get, HttpCode, HttpException, Inject, Post, Put, Req, UnauthorizedException } from "@nestjs/common";
import { eq, lt } from "drizzle-orm";
import type { Request } from "express";
import { z } from "zod";
import { APP_CONFIG, type AppConfig } from "../config";
import { DB, type Db } from "../db/db.module";
import { adminSessions, settings } from "../db/schema";
import { ZodPipe } from "../zod.pipe";
import { CurrentPrincipal, RequireAccess, type Principal } from "./auth";
import { hashPassword, hashToken, newToken, sameToken, verifyPassword } from "./tokens";

const loginSchema = z.object({ secret: z.string().max(500) });
const passwordSchema = z.object({
  password: z.string().min(8, "Пароль — не короче 8 символов").max(200, "Пароль слишком длинный"),
});

/** Сколько неверных паролей подряд можно ввести с одного адреса и на сколько потом закрывается вход. */
export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * 60_000;
/** Сколько живёт вход по паролю: на многодневный турнир хватает, украденный вход сам перестаёт работать. */
const SESSION_MS = 7 * 24 * 3600_000;
const PASSWORD_KEY = "admin_password";

@Controller("auth")
export class AuthController {
  /** Неверные попытки по адресам планшетов и компьютеров: живут в памяти, перезапуск сервера их сбрасывает. */
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Вход в секретариат паролем или токеном из окна запуска. Отдаёт токен входа для этой вкладки.
   * После 5 неверных паролей с адреса вход паролем закрыт на 15 минут; токен из окна запуска работает всегда.
   */
  @Post("login")
  @HttpCode(200)
  async login(@Body(new ZodPipe(loginSchema)) body: { secret: string }, @Req() req: Request) {
    const secret = body.secret.trim();
    if (!secret) throw new UnauthorizedException("Введите пароль секретариата");
    if (!sameToken(secret, this.config.adminToken)) {
      const ip = req.ip ?? "";
      const now = Date.now();
      const state = this.failures.get(ip);
      if (state && state.lockedUntil > now) {
        const minutes = Math.ceil((state.lockedUntil - now) / 60_000);
        throw new HttpException(
          `Слишком много неверных паролей. Вход паролем закрыт ещё на ${minutes} мин. Можно войти токеном из окна запуска сервера.`,
          429,
        );
      }
      const stored = await this.passwordHash();
      if (!stored || !verifyPassword(secret, stored)) {
        const count = (state && state.lockedUntil <= now && state.lockedUntil > 0 ? 0 : (state?.count ?? 0)) + 1;
        const locked = count >= MAX_FAILURES;
        this.failures.set(ip, { count: locked ? 0 : count, lockedUntil: locked ? now + LOCK_MS : 0 });
        if (locked) {
          throw new HttpException(
            `Неверный пароль. Это ${MAX_FAILURES}-я ошибка: вход паролем с этого устройства закрыт на ${LOCK_MS / 60_000} минут.`,
            429,
          );
        }
        throw new UnauthorizedException(
          stored ? `Неверный пароль. Осталось попыток: ${MAX_FAILURES - count}` : "Неверный токен. Пароль секретариата ещё не задан: войдите токеном из окна запуска сервера",
        );
      }
      this.failures.delete(ip);
    }
    return { token: await this.newSession(), passwordSet: Boolean(await this.passwordHash()) };
  }

  /** Проверка, что вход ещё действует, и задан ли пароль. */
  @Get("session")
  @RequireAccess("admin")
  async session() {
    return { passwordSet: Boolean(await this.passwordHash()) };
  }

  /** Новый пароль: все прежние входы закрываются, текущая вкладка получает новый вход. */
  @Put("password")
  @RequireAccess("admin")
  async setPassword(@Body(new ZodPipe(passwordSchema)) body: { password: string }) {
    const value = hashPassword(body.password);
    await this.db.insert(settings).values({ key: PASSWORD_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    await this.db.delete(adminSessions);
    return { token: await this.newSession(), passwordSet: true };
  }

  @Post("logout")
  @HttpCode(200)
  @RequireAccess("admin")
  async logout(@CurrentPrincipal() principal: Principal) {
    if (principal.kind === "admin" && principal.sessionId) {
      await this.db.delete(adminSessions).where(eq(adminSessions.id, principal.sessionId));
    }
    return { ok: true };
  }

  /** «Выйти на всех устройствах»: все входы по паролю перестают работать, в том числе этот. */
  @Post("logout-all")
  @HttpCode(200)
  @RequireAccess("admin")
  async logoutAll() {
    await this.db.delete(adminSessions);
    return { ok: true };
  }

  private async passwordHash(): Promise<string | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, PASSWORD_KEY));
    return row?.value ?? null;
  }

  private async newSession(): Promise<string> {
    const token = newToken();
    await this.db.delete(adminSessions).where(lt(adminSessions.expiresAt, new Date()));
    await this.db.insert(adminSessions).values({ tokenHash: hashToken(token), expiresAt: new Date(Date.now() + SESSION_MS) });
    return token;
  }
}
