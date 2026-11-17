import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import type { Request } from "express";
import { finalize, type Observable } from "rxjs";

/** Сколько живёт готовый снимок, если за это время ничего не поменялось (страховка от пропущенного сброса). */
export const SNAPSHOT_TTL_MS = 3000;

interface Entry<T> {
  generation: number;
  at: number;
  value?: T;
  pending?: Promise<T>;
}

/**
 * Снимок результатов считается один раз на всех: десять табло и сотня телефонов,
 * пришедшие за ним после одной оценки, получают одну и ту же готовую таблицу.
 * Любая правка (оценка, вызов, ротация, состав) сбрасывает снимок, поэтому
 * свежая оценка видна сразу, а не через несколько секунд.
 */
@Injectable()
export class SnapshotCache {
  private generation = 0;
  private readonly entries = new Map<string, Entry<unknown>>();

  /** Данные изменились: следующий запрос посчитает снимок заново. */
  invalidate(): void {
    this.generation++;
    this.entries.clear();
  }

  get<T>(competitionId: string, compute: () => Promise<T>, now = Date.now()): Promise<T> {
    const entry = this.entries.get(competitionId) as Entry<T> | undefined;
    if (entry && entry.generation === this.generation) {
      if (entry.pending) return entry.pending;
      if (now - entry.at < SNAPSHOT_TTL_MS) return Promise.resolve(entry.value as T);
    }
    const generation = this.generation;
    const fresh: Entry<T> = { generation, at: now };
    fresh.pending = compute().then(
      (value) => {
        // Пока считали, данные успели поменяться: такой снимок не запоминаем.
        if (this.entries.get(competitionId) === fresh && this.generation === generation) {
          fresh.value = value;
          fresh.at = Date.now();
          fresh.pending = undefined;
        }
        return value;
      },
      (error: unknown) => {
        if (this.entries.get(competitionId) === fresh) this.entries.delete(competitionId);
        throw error;
      },
    );
    this.entries.set(competitionId, fresh);
    return fresh.pending;
  }
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Любой запрос на изменение сбрасывает снимки, когда ответ уже готов (данные записаны). */
@Injectable()
export class SnapshotInvalidator implements NestInterceptor {
  constructor(private readonly cache: SnapshotCache) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const method = context.switchToHttp().getRequest<Request>().method;
    if (READ_METHODS.has(method)) return next.handle();
    this.cache.invalidate();
    return next.handle().pipe(finalize(() => this.cache.invalidate()));
  }
}
