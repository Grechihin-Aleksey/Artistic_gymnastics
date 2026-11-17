import { readFile, readdir, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { apparatusFor } from "@ag/scoring";
import { APPARATUS_NAMES, LOW_BATTERY_PERCENT, type ReadinessCheck, type ReadinessView } from "@ag/shared";
import { and, eq } from "drizzle-orm";
import { CloudBackupService } from "../backup/cloud-backup.service";
import { CompetitionsService } from "../competitions/competitions.service";
import { APP_CONFIG, type AppConfig } from "../config";
import { DB, type Db } from "../db/db.module";
import { categories, gymnasts, judges, teams } from "../db/schema";
import { LiveGateway } from "../live/live.gateway";
import { RelayPublisher } from "../relay/relay.publisher";

/** Копия базы старше этого — повод проверить, работает ли контейнер backup. */
const BACKUP_STALE_MINUTES = 15;
/** Пробное восстановление идёт раз в сутки; старше этого — проверка перестала работать. */
const RESTORE_CHECK_STALE_HOURS = 26;
/** Свободное место на диске с копиями: меньше — предупреждение, совсем мало — ошибка. */
const DISK_WARN_GB = 5;
const DISK_FAIL_GB = 1;

type JudgeRow = typeof judges.$inferSelect;

function judgeTitle(j: JudgeRow): string {
  return `${j.role === "SUPERVISOR" ? "старший судья" : `${j.role}${j.seat}`} ${j.name}`;
}

/**
 * «Готовность к старту»: одним списком всё, что секретариат проверяет перед
 * соревнованием, — участники, бригады на снарядах, планшеты на связи, формат
 * команд, правила, главная судейская коллегия, сайт и резервные копии.
 */
@Injectable()
export class ReadinessService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly competitions: CompetitionsService,
    private readonly live: LiveGateway,
    private readonly relay: RelayPublisher,
    private readonly cloud: CloudBackupService,
  ) {}

  async check(competitionId: string, now: Date = new Date()): Promise<ReadinessView> {
    const competition = await this.competitions.get(competitionId);
    const checks: ReadinessCheck[] = [];
    const add = (group: string, status: ReadinessCheck["status"], text: string) => checks.push({ group, status, text });

    // Участники
    const people = await this.db
      .select({ id: gymnasts.id, teamId: gymnasts.teamId, categoryId: gymnasts.categoryId, status: gymnasts.status })
      .from(gymnasts)
      .where(eq(gymnasts.competitionId, competitionId));
    const active = people.filter((g) => g.status === "ACTIVE");
    if (active.length === 0) add("Участники", "fail", "Участников нет: загрузите заявки или вставьте список.");
    else {
      const off = people.length - active.length;
      add("Участники", "ok", `Выступают ${active.length}${off > 0 ? `, неявка или снятие — ${off}` : ""}.`);
    }

    // Бригады на снарядах
    const panel = await this.db.select().from(judges).where(eq(judges.competitionId, competitionId));
    const program = apparatusFor(competition.discipline);
    const needTablets: JudgeRow[] = [];
    for (const apparatus of program) {
      const name = APPARATUS_NAMES[apparatus] ?? apparatus;
      const here = panel.filter((j) => j.apparatus === apparatus);
      const supervisor = here.find((j) => j.role === "SUPERVISOR");
      const d = here.filter((j) => j.role === "D");
      const e = here.filter((j) => j.role === "E");
      const missing: string[] = [];
      if (e.length === 0) missing.push("нет судей E");
      if (competition.rules === "FIG" && d.length === 0 && !supervisor) missing.push("некому ставить оценку D");
      if (missing.length > 0) {
        add("Судьи", "fail", `${name}: ${missing.join(", ")}.`);
      } else {
        const tablet = supervisor?.enterAllMarks ? ", один планшет на бригаду" : "";
        const text = `${name}: ${supervisor ? "старший судья, " : ""}D — ${d.length}, E — ${e.length}${tablet}.`;
        add("Судьи", supervisor ? "ok" : "warn", supervisor ? text : `${text} Нет старшего судьи: вызывать и утверждать будет секретариат.`);
      }
      needTablets.push(...(supervisor?.enterAllMarks ? [supervisor] : here));
    }

    // Планшеты на связи
    if (needTablets.length > 0) {
      const states = new Map(this.live.presence(needTablets.map((j) => j.id)).map((p) => [p.judgeId, p]));
      const presence = new Map([...states].map(([id, p]) => [id, p.online]));
      const offline = needTablets.filter((j) => !presence.get(j.id));
      const low = needTablets.filter((j) => {
        const b = states.get(j.id)?.battery;
        return states.get(j.id)?.online && b && !b.charging && b.percent <= LOW_BATTERY_PERCENT;
      });
      if (low.length > 0) {
        const list = low.map((j) => `${APPARATUS_NAMES[j.apparatus] ?? j.apparatus} — ${judgeTitle(j)} (${states.get(j.id)!.battery!.percent}%)`);
        add("Планшеты", "warn", `Мало заряда: ${list.join("; ")}. Поставьте на зарядку.`);
      }
      if (offline.length === 0) add("Планшеты", "ok", `Все планшеты на связи: ${needTablets.length}.`);
      else {
        const list = offline.map((j) => `${APPARATUS_NAMES[j.apparatus] ?? j.apparatus} — ${judgeTitle(j)}`).join("; ");
        add("Планшеты", "warn", `Не на связи ${offline.length} из ${needTablets.length}: ${list}.`);
      }
    }

    // Формат команд
    const teamRows = await this.db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.competitionId, competitionId));
    const format = `${competition.teamRoster}-${competition.teamPerApparatus}-${competition.teamCounting}`;
    const teamProblems: string[] = [];
    for (const team of teamRows) {
      const size = active.filter((g) => g.teamId === team.id).length;
      if (size > competition.teamRoster) teamProblems.push(`«${team.name}»: ${size} уч., в составе допускается ${competition.teamRoster}`);
      else if (size > competition.teamPerApparatus) {
        teamProblems.push(`«${team.name}»: ${size} уч., а на снаряде за команду выступают ${competition.teamPerApparatus}`);
      }
    }
    if (teamRows.length > 0) {
      if (teamProblems.length === 0) add("Команды", "ok", `Команд ${teamRows.length}, формат ${format} подходит к составам.`);
      else {
        add(
          "Команды",
          "warn",
          `Формат ${format}. ${teamProblems.join("; ")}. Если на снаряд выйдут все, командный протокол не соберётся: ` +
            `нужен формат ${competition.teamRoster}-${competition.teamRoster}-${competition.teamCounting}.`,
        );
      }
    }

    // Свои правила: база для каждого разряда
    if (competition.rules === "CUSTOM") {
      const cats = await this.db.select().from(categories).where(eq(categories.competitionId, competitionId));
      const used = new Set(active.map((g) => g.categoryId));
      const noBase = cats.filter((c) => used.has(c.id) && c.base === null && program.some((a) => c.apparatusBase[a] === undefined));
      const noCategory = active.filter((g) => !g.categoryId).length;
      if (noBase.length > 0) add("Правила", "fail", `Не задана база для разрядов: ${noBase.map((c) => c.name).join(", ")}.`);
      if (noCategory > 0) add("Правила", "fail", `У ${noCategory} уч. не указан разряд: базу взять неоткуда.`);
      if (noBase.length === 0 && noCategory === 0) add("Правила", "ok", "Свои правила: база задана для всех разрядов.");
    } else {
      add("Правила", "ok", "Правила FIG.");
    }

    // Главная судейская коллегия
    const { chiefJudge, chiefSecretary } = competition.officials;
    if (chiefJudge && chiefSecretary) add("Коллегия", "ok", `Главный судья ${chiefJudge.name}, главный секретарь ${chiefSecretary.name}.`);
    else {
      const who = [!chiefJudge && "главного судьи", !chiefSecretary && "главного секретаря"].filter(Boolean).join(" и ");
      add("Коллегия", "warn", `Не вписаны фамилии ${who}: подписи под протоколами останутся пустыми.`);
    }

    // Сайт
    if (competition.trial) add("Сайт", "ok", "Пробный турнир на сайт не уходит.");
    else {
      const site = this.relay.status(competitionId);
      if (!site.enabled) add("Сайт", "warn", "Сайт не подключён: результаты будут только в зале.");
      else if (site.error) add("Сайт", "warn", `Результаты не доходят до сайта: ${site.error}. Зал работает, сайт догонит, когда связь вернётся.`);
      else if (!site.sentAt) add("Сайт", "warn", "Турнир ещё не отправлялся на сайт: нажмите «Отправить на сайт» на экране «Соревнование».");
      else add("Сайт", "ok", "Результаты доходят до сайта.");
    }

    // Резервные копии
    const dir = this.config.backupDir;
    if (dir) {
      const latest = await newestDump(dir);
      if (!latest) add("Копии", "fail", "Резервных копий базы нет: проверьте, что программа запущена через «Запуск» (контейнер backup).");
      else {
        const minutes = Math.floor((now.getTime() - latest) / 60_000);
        if (minutes > BACKUP_STALE_MINUTES) add("Копии", "warn", `Последняя копия базы ${minutes} мин назад: копии перестали сниматься.`);
        else add("Копии", "ok", `Последняя копия базы ${minutes < 1 ? "меньше минуты" : `${minutes} мин`} назад.`);
      }
    }
    if (dir) {
      const restore = await readRestoreCheck(dir);
      if (restore) {
        const hours = Math.floor((now.getTime() - Date.parse(restore.at)) / 3_600_000);
        const ago = hours < 1 ? "меньше часа назад" : `${hours} ч назад`;
        if (!restore.ok) {
          add("Копии", "fail", `Пробное восстановление из копии ${restore.file} не удалось (${ago}): ${restore.error ?? "ошибка"}. Сообщите тому, кто ставил программу.`);
        } else if (hours >= RESTORE_CHECK_STALE_HOURS) {
          add("Копии", "warn", `Пробное восстановление из копии давно не проводилось (${ago}): перезапустите программу через «Запуск».`);
        } else {
          add("Копии", "ok", `Пробное восстановление из копии прошло ${ago}: турниров в копии ${restore.competitions ?? 0}.`);
        }
      }
      const free = await freeBytes(dir);
      if (free !== null) {
        const gb = free / 1024 ** 3;
        const text = `Свободно на диске ${gb.toFixed(1)} ГБ.`;
        if (gb < DISK_FAIL_GB) add("Диск", "fail", `${text} Копии и протоколы скоро перестанут сохраняться: освободите место (старые видео, загрузки, корзина).`);
        else if (gb < DISK_WARN_GB) add("Диск", "warn", `${text} Места мало: старые копии базы удаляются раньше срока, освободите место на компьютере.`);
        else add("Диск", "ok", text);
      }
    }
    const cloud = this.cloud.status();
    if (cloud.enabled && cloud.lastError) add("Копии", "warn", `Копия в облако не отправилась: ${cloud.lastError}.`);

    const worst = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "ok";
    return { status: worst, checks, checkedAt: now.toISOString() };
  }
}

async function newestDump(dir: string): Promise<number | null> {
  try {
    const names = (await readdir(dir)).filter((n) => /^gymnastics-.*\.dump$/.test(n));
    const times = await Promise.all(names.map(async (n) => (await stat(join(dir, n))).mtimeMs));
    return times.length > 0 ? Math.max(...times) : null;
  } catch {
    return null;
  }
}

interface RestoreCheck {
  ok: boolean;
  at: string;
  file: string;
  competitions?: number;
  error?: string;
}

/** Итог пробного восстановления, который пишет контейнер backup (scripts/backup-loop.sh). */
async function readRestoreCheck(dir: string): Promise<RestoreCheck | null> {
  try {
    const data = JSON.parse(await readFile(join(dir, "restore-check.json"), "utf8")) as RestoreCheck;
    return typeof data.ok === "boolean" && typeof data.at === "string" && !Number.isNaN(Date.parse(data.at)) ? data : null;
  } catch {
    return null;
  }
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const fs = await statfs(dir);
    return fs.bavail * fs.bsize;
  } catch {
    return null;
  }
}
