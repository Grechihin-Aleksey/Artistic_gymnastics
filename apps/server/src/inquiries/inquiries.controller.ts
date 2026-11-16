import { Body, Controller, Get, HttpException, Param, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import {
  coachInquirySchema,
  createInquirySchema,
  type CoachInquiryInput,
  resolveInquirySchema,
  type CreateInquiryInput,
  type ResolveInquiryInput,
} from "@ag/shared";
import { AllowChief, CurrentPrincipal, RequireAccess, type Principal } from "../auth/auth";
import { ZodPipe } from "../zod.pipe";
import { InquiriesService } from "./inquiries.service";

/** Запросы записывает и решения жюри вносит секретариат или главный судья со своего планшета. */
@Controller()
@RequireAccess("admin")
@AllowChief()
export class InquiriesController {
  constructor(private readonly inquiries: InquiriesService) {}

  @Post("performances/:id/inquiries")
  create(
    @CurrentPrincipal() principal: Principal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(createInquirySchema)) body: CreateInquiryInput,
  ) {
    return this.inquiries.create(principal, id, body);
  }

  @Get("competitions/:id/inquiries")
  list(@Param("id", ParseUUIDPipe) id: string) {
    return this.inquiries.list(id);
  }

  @Post("inquiries/:id/resolve")
  resolve(
    @CurrentPrincipal() principal: Principal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(resolveInquirySchema)) body: ResolveInquiryInput,
  ) {
    return this.inquiries.resolve(principal, id, body);
  }
}

/** Сколько запросов можно подать с одного телефона за окно: от случайных повторов и баловства. */
const COACH_LIMIT = 5;
const COACH_WINDOW_MS = 10 * 60_000;

/**
 * Запрос тренера с телефона: страница «Мой клуб» на табло в сети зала. Открыт без входа,
 * как и результаты; сайт для зрителей запросы не пропускает (ретранслятор отдаёт только чтение).
 */
@Controller()
export class CoachInquiriesController {
  /** Подачи по адресам телефонов: живут в памяти, перезапуск сервера их сбрасывает. */
  private readonly recent = new Map<string, number[]>();

  constructor(private readonly inquiries: InquiriesService) {}

  @Post("competitions/:id/coach-inquiries")
  create(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(coachInquirySchema)) body: CoachInquiryInput,
    @Req() req: Request,
  ) {
    const ip = req.ip ?? "";
    const now = Date.now();
    const times = (this.recent.get(ip) ?? []).filter((t) => now - t < COACH_WINDOW_MS);
    if (times.length >= COACH_LIMIT) {
      throw new HttpException("С этого телефона уже подано несколько запросов. Следующий — через несколько минут или через секретариат.", 429);
    }
    times.push(now);
    this.recent.set(ip, times);
    return this.inquiries.createFromCoach(id, body);
  }
}
