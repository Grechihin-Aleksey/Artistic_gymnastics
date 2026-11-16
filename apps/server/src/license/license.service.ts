import { BadRequestException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../config";
import { DB, type Db } from "../db/db.module";
import { settings } from "../db/schema";
import { daysLeft, localDate, readLicense, type License } from "./license";

const KEY_SETTING = "license_key";
/** Самое позднее время, которое видел сервер: перевод часов назад не продлевает лицензию. */
const CLOCK_SETTING = "license_clock";
/** За сколько дней до конца срока секретариат видит предупреждение. */
export const WARN_DAYS = 30;

export type LicenseState = "active" | "expired" | "missing" | "invalid";

export interface LicenseStatus {
  state: LicenseState;
  license: License | null;
  /** Сколько дней осталось, считая сегодняшний; у истёкшей 0 и меньше. */
  daysLeft: number | null;
  /** Нужна ли программе лицензия; без неё — только пробные турниры. */
  required: boolean;
}

export const NO_LICENSE_MESSAGE =
  "Без действующей лицензии можно проводить только пробный турнир. Введите ключ лицензии на экране «Соревнование», блок «Лицензия».";

@Injectable()
export class LicenseService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async status(): Promise<LicenseStatus> {
    const required = this.config.licenseRequired ?? false;
    const key = (await this.setting(KEY_SETTING)) ?? this.config.licenseKey ?? null;
    if (!key) return { state: "missing", license: null, daysLeft: null, required };
    const license = readLicense(key, this.config.licensePublicKey);
    if (!license) return { state: "invalid", license: null, daysLeft: null, required };
    const left = daysLeft(license.until, localDate(await this.now()));
    return { state: left > 0 ? "active" : "expired", license, daysLeft: left, required };
  }

  /** Новый ключ из секретариата: сохраняем только верный и неистёкший. */
  async save(key: string): Promise<LicenseStatus> {
    const value = key.replace(/\s+/g, "");
    const license = readLicense(value, this.config.licensePublicKey);
    if (!license) throw new BadRequestException("Ключ лицензии неверный: проверьте, что он скопирован целиком");
    if (daysLeft(license.until, localDate(await this.now())) <= 0) {
      throw new BadRequestException(`Срок этой лицензии закончился ${license.until.split("-").reverse().join(".")}`);
    }
    await this.db.insert(settings).values({ key: KEY_SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    return this.status();
  }

  /**
   * Новый настоящий турнир — только с действующей лицензией. Уже идущие турниры
   * лицензия не останавливает: оценки, протоколы и сайт работают и после конца срока.
   */
  async assertCanCreate(trial: boolean): Promise<void> {
    if (trial || !this.config.licenseRequired) return;
    const status = await this.status();
    if (status.state !== "active") throw new ForbiddenException(NO_LICENSE_MESSAGE);
  }

  private async now(): Promise<Date> {
    const now = new Date();
    const saved = await this.setting(CLOCK_SETTING);
    const seen = saved ? new Date(saved) : null;
    if (seen && seen > now) return seen;
    const value = now.toISOString();
    await this.db.insert(settings).values({ key: CLOCK_SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    return now;
  }

  private async setting(key: string): Promise<string | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, key));
    return row?.value ?? null;
  }
}
