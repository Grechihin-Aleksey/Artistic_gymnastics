import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { apparatusFor, fromPoints, scorePerformance, toPoints, type Apparatus, type Discipline } from "@ag/scoring";
import { AUDIT_GROUP_NAMES, AUDIT_GROUPS, GYMNAST_STATUSES, GYMNAST_STATUS_NAMES, JUDGE_CATEGORIES, scoreLabels, type GymnastStatus, type Official } from "@ag/shared";
import type { ImportGymnastsInput } from "@ag/shared";
import type { AuditEntry, AuditGroup, BoardSnapshot, OnlineEntriesView, ProtocolsIndex, Ceremony, CeremonyView, ClubStandingView, DrawView, FinalsView, InquiryView, NormativesView, PerformanceView, RotationView, Rules, RulesView, SeriesStandings, SeriesView } from "@ag/shared";
import { ApparatusIcon } from "./ApparatusIcon";
import { ApiError, apiRequest } from "./api";
import { APPARATUS_NAMES, expandScore, judgeLabel, parsePoints, parseScore } from "./labels";
import { parseRoster, splitByGender, teamFormatWarnings, type TeamFormat } from "./roster";
import { useCompetitionLive } from "./useLive";

interface Gymnast {
  id: string;
  bib: number;
  firstName: string;
  lastName: string;
}

interface RosterGymnast extends Gymnast {
  club: string | null;
  teamId: string | null;
  categoryId: string | null;
  shift: number | null;
  status: GymnastStatus;
  middleName: string | null;
  birthDate: string | null;
  city: string | null;
  coach: string | null;
}

/**
 * Кнопка «Сохранить» помнит, что сохранено: после сохранения она зелёная с надписью «Сохранено»,
 * а любая правка в блоке (ввод в поле или другая кнопка) возвращает её к «Сохранить».
 */
function useSaved() {
  const [saved, setSaved] = useState(false);
  const reset = () => setSaved(false);
  return {
    saved,
    markSaved: () => setSaved(true),
    /** Разложить на блок с полями. */
    watch: {
      onInputCapture: reset,
      onClickCapture: (e: MouseEvent) => {
        const button = (e.target as HTMLElement).closest("button");
        if (button && !button.hasAttribute("data-save")) reset();
      },
    },
  };
}

function SaveButton({
  saved,
  disabled,
  onClick,
  children,
}: {
  saved: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" data-save className={saved ? "primary saved" : "primary"} disabled={disabled} onClick={onClick}>
      {saved ? "✓ Сохранено" : children}
    </button>
  );
}

interface Props {
  competitionId: string;
  discipline: Discipline;
  adminToken: string;
  onError: (message: string | null) => void;
  /** По своим правилам вместо оценки D — стоимость упражнения. */
  rules?: Rules;
}

const fmt = (n: number) => n.toFixed(3);

interface Category {
  id: string | null;
  name: string;
}

/** Значение параметра ?category=: id разряда или none для участников без разряда. */
const categoryParam = (c: Category | undefined) => (c ? (c.id ?? "none") : "");

/**
 * Смены и ротации. Смены переходят со снаряда на снаряд по олимпийскому порядку;
 * секретариат задаёт стартовые снаряды и переводит всех на следующую ротацию.
 */
export function RotationPanel({ competitionId, discipline, adminToken, onError }: Props) {
  const [view, setView] = useState<RotationView | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  // Разряды смены: id участника → название его разряда.
  const [categoryOf, setCategoryOf] = useState<Map<string, string>>(new Map());
  const [categoryOrder, setCategoryOrder] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const [rotation, perfs, people, categoryList] = await Promise.all([
        apiRequest<RotationView>(`/competitions/${competitionId}/rotation`),
        apiRequest<PerformanceView[]>(`/competitions/${competitionId}/performances`, { token: adminToken }),
        apiRequest<RosterGymnast[]>(`/competitions/${competitionId}/gymnasts`),
        apiRequest<{ id: string; name: string }[]>(`/competitions/${competitionId}/categories`),
      ]);
      setView(rotation);
      const names = new Map(categoryList.map((c) => [c.id, c.name]));
      setCategoryOf(new Map(people.flatMap((g) => (g.categoryId && names.has(g.categoryId) ? [[g.id, names.get(g.categoryId)!] as const] : []))));
      setCategoryOrder(categoryList.map((c) => c.name));
      setDone(
        new Set(perfs.filter((p) => p.status === "APPROVED" && p.attempt === 1).map((p) => `${p.gymnastId}:${p.apparatus}`)),
      );
    } catch (e) {
      onError((e as Error).message);
    }
  }, [competitionId, adminToken, onError]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  if (!view || view.shifts.length === 0) return null;

  const progress = view.shifts.map((s) => ({
    ...s,
    performed: s.gymnastIds.filter((id) => done.has(`${id}:${s.apparatus}`)).length,
  }));
  const categoriesIn = (ids: string[]) =>
    categoryOrder.filter((name) => ids.some((id) => categoryOf.get(id) === name)).join(", ");
  const unfinished = progress.filter((s) => s.performed < s.gymnastIds.length);

  const setRotation = async (rotation: number) => {
    if (rotation > view.rotation && unfinished.length > 0) {
      const list = unfinished.map((s) => `смена ${s.number}: ${s.performed} из ${s.gymnastIds.length}`).join(", ");
      if (!confirm(`Выступили не все (${list}). Всё равно перейти?`)) return;
    }
    try {
      setView(await apiRequest<RotationView>(`/competitions/${competitionId}/rotation`, {
        token: adminToken,
        method: "POST",
        body: { rotation },
      }));
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const setStart = async (number: number, startApparatus: string) => {
    try {
      setView(await apiRequest<RotationView>(`/competitions/${competitionId}/shifts/${number}`, {
        token: adminToken,
        method: "PUT",
        body: { startApparatus },
      }));
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <section className="panel rotation no-print">
      <h2>
        Ротация {view.rotation + 1} из {view.rotations}
      </h2>
      <table className="wide">
        <thead>
          <tr>
            <th>Смена</th>
            <th>Разряды</th>
            <th>Начинает на</th>
            <th>Сейчас на снаряде</th>
            <th>Выступили</th>
          </tr>
        </thead>
        <tbody>
          {progress.map((s) => (
            <tr key={s.number}>
              <td>{s.number}</td>
              <td>{categoriesIn(s.gymnastIds)}</td>
              <td>
                <select
                  value={s.startApparatus}
                  disabled={view.rotation > 0}
                  title={view.rotation > 0 ? "Стартовый снаряд меняют до начала соревнования" : undefined}
                  onChange={(e) => void setStart(s.number, e.target.value)}
                >
                  {apparatusFor(discipline).map((a) => (
                    <option key={a} value={a}>
                      {APPARATUS_NAMES[a]}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <strong>
                  <ApparatusIcon code={s.apparatus} />
                  {APPARATUS_NAMES[s.apparatus]}
                </strong>
              </td>
              <td className={s.performed === s.gymnastIds.length ? "ok" : ""}>
                {s.performed} из {s.gymnastIds.length}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="buttons wide">
        <button type="button" disabled={view.rotation === 0} onClick={() => void setRotation(view.rotation - 1)}>
          ← Предыдущая
        </button>
        <button
          type="button"
          className="primary"
          disabled={view.rotation + 1 >= view.rotations}
          onClick={() => void setRotation(view.rotation + 1)}
        >
          Следующая ротация →
        </button>
      </div>
    </section>
  );
}

/** Скачивает протокол: PDF показывает в заранее открытой вкладке tab, остальное сохраняет файлом. */
async function fetchProtocol(competitionId: string, adminToken: string, path: string, filename: string, tab: Window | null) {
  const response = await fetch(`/competitions/${competitionId}/protocols/${path}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(response.status, data?.message ?? `Ошибка сервера ${response.status}`);
  }
  const url = URL.createObjectURL(await response.blob());
  if (tab) tab.location.href = url;
  else {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  }
}

/** Протоколы в PDF: открываются в новой вкладке, оттуда их печатают или сохраняют. */
export function ProtocolsPanel({ competitionId, discipline, adminToken, onError }: Props) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState("");
  useEffect(() => {
    apiRequest<Category[]>(`/competitions/${competitionId}/results/categories`)
      .then((list) => {
        setCategories(list);
        setCategory((current) => current || categoryParam(list[0]));
      })
      .catch(() => setCategories([]));
  }, [competitionId]);

  /** PDF открывается в новой вкладке, Excel скачивается файлом. */
  const open = async (path: string, filename: string, byCategory = true) => {
    const download = filename.endsWith(".xlsx");
    // Окно открываем сразу по нажатию, иначе браузер сочтёт его всплывающей рекламой.
    const tab = download ? null : window.open("", "_blank");
    const query =
      byCategory && (categories.length > 1 || categories[0]?.id)
        ? `${path.includes("?") ? "&" : "?"}category=${category}`
        : "";
    try {
      await fetchProtocol(competitionId, adminToken, `${path}${query}`, filename, tab);
      onError(null);
    } catch (e) {
      tab?.close();
      onError(e instanceof ApiError && e.status !== 0 ? e.message : "Нет связи с сервером");
    }
  };

  return (
    <section className="panel protocols no-print">
      <h2>Перед стартом</h2>
      <div className="buttons">
        <button type="button" onClick={() => void open("start-list", "start-list.pdf", false)}>
          Стартовый протокол
        </button>
        <button type="button" onClick={() => void open("bibs", "bibs.pdf", false)}>
          Нагрудные номера
        </button>
        <button type="button" onClick={() => void open("officials", "officials.pdf", false)}>
          Судейская коллегия
        </button>
        {apparatusFor(discipline).map((a) => (
          <button key={a} type="button" onClick={() => void open(`sheet/${a}`, `sheet-${a}.pdf`, false)}>
            Ведомость: {APPARATUS_NAMES[a]}
          </button>
        ))}
      </div>
      <LogoControl competitionId={competitionId} adminToken={adminToken} onError={onError} />
      <h2>Протоколы</h2>
      {categories.length > 0 && categories[0]!.id !== null && (
        <label>
          Разряд
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((c) => (
              <option key={categoryParam(c)} value={categoryParam(c)}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="buttons">
        {apparatusFor(discipline).map((a) => (
          <button key={a} type="button" onClick={() => void open(`apparatus/${a}`, `protocol-${a}.pdf`)}>
            {APPARATUS_NAMES[a]}
          </button>
        ))}
        <button type="button" onClick={() => void open("all-around", "protocol-all-around.pdf")}>
          Многоборье
        </button>
        <button type="button" onClick={() => void open("teams", "protocol-teams.pdf")}>
          Команды
        </button>
        <button type="button" onClick={() => void open("results.xlsx", "results.xlsx", false)}>
          Все итоги в Excel
        </button>
        <button type="button" onClick={() => void open("earned", "earned.pdf", false)}>
          Выполнили разряды
        </button>
        <button type="button" onClick={() => void open("clubs", "clubs.pdf", false)}>
          Общекомандный зачёт
        </button>
        <button type="button" onClick={() => void open("report", "report.pdf", false)}>
          Итоговый отчёт
        </button>
      </div>
      <h2>Финалы на снарядах</h2>
      <p className="muted">Протокол финала — по выбранному разряду, ведомость — финалисты всех разрядов в порядке выступления.</p>
      <div className="buttons">
        {apparatusFor(discipline).map((a) => (
          <button key={a} type="button" onClick={() => void open(`apparatus/${a}?stage=final`, `final-${a}.pdf`)}>
            Финал: {APPARATUS_NAMES[a]}
          </button>
        ))}
      </div>
      <div className="buttons">
        {apparatusFor(discipline).map((a) => (
          <button key={a} type="button" onClick={() => void open(`sheet/${a}?stage=final`, `final-sheet-${a}.pdf`, false)}>
            Ведомость финала: {APPARATUS_NAMES[a]}
          </button>
        ))}
      </div>
      <h2>Грамоты призёрам</h2>
      <p className="muted">По всем разрядам сразу, по листу A4 на каждого призёра. Разделившие место получают грамоту оба.</p>
      <div className="buttons">
        <button type="button" onClick={() => void open("diplomas?kind=all-around", "diplomas.pdf", false)}>
          Многоборье и команды
        </button>
        <button type="button" onClick={() => void open("diplomas?kind=apparatus", "diplomas.pdf", false)}>
          Отдельные снаряды (по финалам, если они были)
        </button>
      </div>
    </section>
  );
}

/** Сжимает картинку до 512 точек по большей стороне и возвращает PNG как data URL. */
async function toLogo(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 512 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Логотип соревнования для шапки всех протоколов. */
function LogoControl({ competitionId, adminToken, onError }: Omit<Props, "discipline">) {
  // Номер версии в адресе картинки, чтобы браузер не показывал старую из кэша.
  const [version, setVersion] = useState(0);
  const [present, setPresent] = useState(false);

  useEffect(() => {
    fetch(`/competitions/${competitionId}/logo`, { method: "HEAD" })
      .then((r) => setPresent(r.ok))
      .catch(() => setPresent(false));
  }, [competitionId, version]);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    try {
      const dataUrl = await toLogo(file).catch(() => {
        throw new Error("Не удалось прочитать картинку");
      });
      await apiRequest(`/competitions/${competitionId}/logo`, { token: adminToken, method: "PUT", body: { dataUrl } });
      setVersion((v) => v + 1);
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const remove = async () => {
    try {
      await apiRequest(`/competitions/${competitionId}/logo`, { token: adminToken, method: "DELETE" });
      setVersion((v) => v + 1);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div className="logo wide">
      {present && <img src={`/competitions/${competitionId}/logo?v=${version}`} alt="Логотип соревнования" />}
      <label className="file">
        {present ? "Заменить логотип" : "Логотип в шапку протоколов"}
        <input type="file" accept="image/*" onChange={(e) => void upload(e.target.files?.[0])} />
      </label>
      {present && (
        <button type="button" className="link" onClick={() => void remove()}>
          Убрать
        </button>
      )}
    </div>
  );
}

const STATUS_NAMES = { PENDING: "Ждёт решения", ACCEPTED: "Удовлетворён", REJECTED: "Отклонён" } as const;

/**
 * Запросы тренеров на пересмотр оценки D. Секретариат записывает запрос
 * и вносит решение апелляционного жюри; новая оценка сразу уходит на табло и сайт.
 */
export function InquiriesPanel({ competitionId, discipline, adminToken, onError, rules }: Props) {
  const custom = rules === "CUSTOM";
  const dName = custom ? "Стоимость" : "Оценка D";
  const dShort = custom ? "стоимость" : "D";
  const dError = `${dName}: число до 20 с точностью до тысячных, например ${custom ? "9.500" : "5.400"}`;
  const [apparatus, setApparatus] = useState<string>(apparatusFor(discipline)[0]!);
  const [performances, setPerformances] = useState<PerformanceView[]>([]);
  const [performanceId, setPerformanceId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [gymnasts, setGymnasts] = useState<Map<string, Gymnast>>(new Map());
  const [inquiries, setInquiries] = useState<InquiryView[]>([]);
  // Снаряд последней загрузки: опоздавший ответ по прежнему снаряду не подменяет список.
  const current = useRef(apparatus);
  current.current = apparatus;

  const load = useCallback(async () => {
    try {
      const [perfs, people, list] = await Promise.all([
        apiRequest<PerformanceView[]>(`/competitions/${competitionId}/performances?apparatus=${apparatus}`, {
          token: adminToken,
        }),
        apiRequest<Gymnast[]>(`/competitions/${competitionId}/gymnasts`),
        apiRequest<InquiryView[]>(`/competitions/${competitionId}/inquiries`, { token: adminToken }),
      ]);
      if (current.current !== apparatus) return;
      // Свежие оценки сверху: запрос обычно подают на только что показанную.
      const approved = perfs.filter((p) => p.status === "APPROVED").reverse();
      setPerformances(approved);
      setLoaded(true);
      // Выбранное выступление пропало из списка — выбор сбрасывается, а не переходит на первое.
      setPerformanceId((id) => (approved.some((p) => p.id === id) ? id : ""));
      setGymnasts(new Map(people.map((g) => [g.id, g])));
      setInquiries([...list].reverse());
    } catch (e) {
      onError((e as Error).message);
    }
  }, [competitionId, apparatus, adminToken, onError]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const submit = async (form: FormData) => {
    const claimed = String(form.get("claimedD") ?? "").replace(",", ".").trim();
    const claimedD = claimed ? parseScore(claimed, "D") : undefined;
    if (claimedD === null) return onError(dError);
    if (!performanceId) return onError("Выберите выступление");
    try {
      await apiRequest(`/performances/${performanceId}/inquiries`, {
        token: adminToken,
        method: "POST",
        body: { coach: String(form.get("coach")), ...(claimedD !== undefined ? { claimedD } : {}) },
      });
      onError(null);
      setPerformanceId("");
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const resolve = async (inquiry: InquiryView, accept: boolean) => {
    let body: object = { decision: "reject" };
    if (accept) {
      const input = prompt(
        `${custom ? "Новая стоимость" : "Новая оценка D"} для №${inquiry.gymnast.bib} ${inquiry.gymnast.lastName} (сейчас ${fmt(inquiry.previousD)})`,
        inquiry.claimedD !== null ? fmt(inquiry.claimedD) : "",
      );
      if (input === null) return;
      const d = parseScore(input.replace(",", ".").trim(), "D");
      if (d === null) return onError(dError);
      body = { decision: "accept", d };
    } else if (!confirm(`Отклонить запрос по №${inquiry.gymnast.bib} ${inquiry.gymnast.lastName}? Оценка останется ${fmt(inquiry.previousD)}.`)) {
      return;
    }
    try {
      await apiRequest(`/inquiries/${inquiry.id}/resolve`, { token: adminToken, method: "POST", body });
      onError(null);
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const name = (gymnastId: string) => {
    const g = gymnasts.get(gymnastId);
    return g ? `№${g.bib} ${g.lastName} ${g.firstName}` : "—";
  };

  return (
    <section className="inquiries no-print">
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          void submit(new FormData(form)).then(() => form.reset());
        }}
      >
        <h2>Запрос на пересмотр {custom ? "стоимости" : "D"}</h2>
        <label>
          Снаряд
          <select
            value={apparatus}
            onChange={(e) => {
              setApparatus(e.target.value);
              setPerformances([]);
              setPerformanceId("");
              setLoaded(false);
            }}
          >
            {apparatusFor(discipline).map((a) => (
              <option key={a} value={a}>
                {APPARATUS_NAMES[a]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Выступление
          <select name="performanceId" required value={performanceId} onChange={(e) => setPerformanceId(e.target.value)}>
            <option value="">{!loaded ? "Загрузка…" : performances.length === 0 ? "Утверждённых оценок нет" : "Выберите выступление"}</option>
            {performances.map((p) => (
              <option key={p.id} value={p.id}>
                {name(p.gymnastId)}
                {p.attempt > 1 ? `, прыжок ${p.attempt}` : ""} — {dShort} {fmt(p.score!.d)}, итог {fmt(p.score!.total)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Тренер
          <input name="coach" required />
        </label>
        <label>
          {custom ? "Стоимость" : "D"} по мнению тренера
          <input name="claimedD" inputMode="decimal" placeholder="необязательно" />
        </label>
        <button type="submit" className="primary" disabled={performances.length === 0}>
          Записать запрос
        </button>
      </form>

      {inquiries.length > 0 && (
        <table className="panel">
          <tbody>
            {inquiries.map((q) => (
              <tr key={q.id} className={q.status === "PENDING" ? "pending" : ""}>
                <td>{APPARATUS_NAMES[q.apparatus]}</td>
                <td>
                  №{q.gymnast.bib} {q.gymnast.lastName} {q.gymnast.firstName}
                  {q.attempt > 1 ? `, прыжок ${q.attempt}` : ""}
                  <div className="muted">
                    {q.coach}, {new Date(q.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                    {q.late && <span className="late"> · подан после срока</span>}
                  </div>
                </td>
                <td>
                  {dShort} {fmt(q.previousD)}
                  {q.claimedD !== null && <div className="muted">просят {fmt(q.claimedD)}</div>}
                </td>
                <td>
                  {STATUS_NAMES[q.status]}
                  {q.newD !== null && q.newD !== q.previousD && <div className="muted">{custom ? "новая стоимость" : "новая D"} {fmt(q.newD)}</div>}
                  {q.note && <div className="muted">{q.note}</div>}
                </td>
                <td className="actions">
                  {q.status === "PENDING" && (
                    <>
                      <button type="button" className="primary" onClick={() => void resolve(q, true)}>
                        Удовлетворить
                      </button>
                      <button type="button" onClick={() => void resolve(q, false)}>
                        Отклонить
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface CompetitionCreated {
  id: string;
}

/** Новое соревнование: название, программа, формат командного зачёта. */
export function NewCompetitionForm({
  adminToken,
  onCreated,
  onError,
}: {
  adminToken: string;
  onCreated: (id: string) => void;
  onError: (message: string | null) => void;
}) {
  const create = async (form: FormData) => {
    try {
      const program = String(form.get("discipline"));
      const post = (discipline: string, pairWith?: string) =>
        apiRequest<CompetitionCreated>("/competitions", {
          token: adminToken,
          method: "POST",
          body: {
            name: String(form.get("name")).trim(),
            discipline,
            teamFormat: {
              roster: Number(form.get("roster")),
              perApparatus: Number(form.get("perApparatus")),
              counting: Number(form.get("counting")),
            },
            publishJudgeMarks: form.get("publishJudgeMarks") === "on",
            rules: String(form.get("rules")),
            ...(pairWith ? { pairWith } : {}),
          },
        });
      // Девочки и мальчики: две связанные части одного турнира, у каждой свой подсчёт.
      const created = await post(program === "MIXED" ? "WAG" : program);
      if (program === "MIXED") await post("MAG", created.id);
      onError(null);
      onCreated(created.id);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <form
      className="panel no-print"
      onSubmit={(e) => {
        e.preventDefault();
        void create(new FormData(e.currentTarget));
      }}
    >
      <h2>Новое соревнование</h2>
      <label className="wide">
        Название
        <input name="name" required maxLength={200} />
      </label>
      <label>
        Программа
        <select name="discipline" defaultValue="WAG">
          <option value="WAG">Женщины (4 снаряда)</option>
          <option value="MAG">Мужчины (6 снарядов)</option>
          <option value="MIXED">Девочки и мальчики (4 и 6 снарядов)</option>
        </select>
      </label>
      <label>
        Правила судейства
        <select name="rules" defaultValue="FIG">
          <option value="FIG">FIG: D + E</option>
          <option value="CUSTOM">Свои: база по разряду минус сбавки</option>
        </select>
      </label>
      <label>
        В составе команды
        <input name="roster" type="number" min={1} max={10} defaultValue={5} required />
      </label>
      <label>
        Выступают на снаряде
        <input name="perApparatus" type="number" min={1} max={10} defaultValue={4} required />
      </label>
      <label>
        Идут в зачёт
        <input name="counting" type="number" min={1} max={10} defaultValue={3} required />
      </label>
      <label className="check">
        <input name="publishJudgeMarks" type="checkbox" />
        Показывать на табло и сайте сбавки каждого судьи E
      </label>
      <button type="submit" className="primary">
        Создать
      </button>
    </form>
  );
}

const DEMO_PEOPLE: Record<Discipline, [string, string][]> = {
  WAG: [
    ["Абрамова", "Анна"],
    ["Белова", "Вера"],
    ["Волкова", "Дарья"],
    ["Гусева", "Ева"],
    ["Дёмина", "Жанна"],
    ["Ершова", "Зоя"],
    ["Жукова", "Ирина"],
    ["Зайцева", "Ксения"],
  ],
  MAG: [
    ["Антонов", "Борис"],
    ["Быков", "Глеб"],
    ["Васильев", "Денис"],
    ["Громов", "Егор"],
    ["Данилов", "Иван"],
    ["Ефимов", "Кирилл"],
    ["Жаров", "Лев"],
    ["Зотов", "Максим"],
  ],
};

/**
 * Пробный турнир для репетиции накануне: 8 участников двух разрядов в двух сменах,
 * на каждом снаряде старший судья с одним планшетом и два судьи E. После проверки его удаляют.
 */
export function DemoCompetitionForm<J>({
  adminToken,
  onCreated,
  onError,
}: {
  adminToken: string;
  /** Старшие судьи с токенами: их QR-коды сразу появятся на экране «Судьи». */
  onCreated: (id: string, supervisors: J[]) => void;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const create = async (form: FormData) => {
    const discipline = String(form.get("discipline")) as Discipline;
    const rules = String(form.get("rules"));
    const program = apparatusFor(discipline);
    const call = <T,>(path: string, body: unknown, method = "POST") =>
      apiRequest<T>(path, { token: adminToken, method, body });
    setBusy(true);
    setDone(false);
    try {
      const date = new Date().toLocaleDateString("ru-RU");
      const { id } = await call<CompetitionCreated>("/competitions", {
        name: `Пробный турнир ${date} — удалить после проверки`,
        discipline,
        rules,
      });
      await call(`/competitions/${id}/gymnasts/import`, {
        rows: DEMO_PEOPLE[discipline].map(([lastName, firstName], i) => ({
          bib: 101 + i,
          lastName,
          firstName,
          club: i % 2 === 0 ? "Пробный клуб А" : "Пробный клуб Б",
          category: i < 4 ? "3 спортивный" : "2 юношеский",
          shift: i < 4 ? 1 : 2,
        })),
      });
      if (rules === "CUSTOM") {
        const categories = await apiRequest<{ id: string }[]>(`/competitions/${id}/categories`, { token: adminToken });
        await call(
          `/competitions/${id}/rules`,
          {
            rules,
            deductions: [{ name: "Нет обязательного элемента", value: 0.5 }],
            bases: categories.map((c) => ({ categoryId: c.id, base: 10, apparatus: {} })),
          },
          "PUT",
        );
      }
      await call(`/competitions/${id}/shifts/1`, { startApparatus: program[0] }, "PUT");
      await call(`/competitions/${id}/shifts/2`, { startApparatus: program[1] }, "PUT");
      const supervisors: J[] = [];
      for (const apparatus of program) {
        supervisors.push(await call<J>(`/competitions/${id}/judges`, {
          name: "Старший судья",
          apparatus,
          role: "SUPERVISOR",
          seat: 1,
          enterAllMarks: true,
        }));
        for (const seat of [1, 2]) await call(`/competitions/${id}/judges`, { name: `Судья E${seat}`, apparatus, role: "E", seat });
      }
      await call(`/competitions/${id}/rotation`, { rotation: 0 });
      setDone(true);
      onError(null);
      onCreated(id, supervisors);
    } catch (e) {
      onError(`Пробный турнир создан не полностью: ${(e as Error).message}. Удалите его и попробуйте ещё раз`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="panel no-print"
      onSubmit={(e) => {
        e.preventDefault();
        void create(new FormData(e.currentTarget));
      }}
    >
      <p className="muted wide">
        Для репетиции накануне: 8 участников двух разрядов в двух сменах, на каждом снаряде старший судья с одним
        планшетом на всю бригаду и два судьи E. Всё как на настоящем турнире: вызов, оценки, табло, протоколы.
      </p>
      <label>
        Программа
        <select name="discipline" defaultValue="WAG">
          <option value="WAG">Женщины (4 снаряда)</option>
          <option value="MAG">Мужчины (6 снарядов)</option>
        </select>
      </label>
      <label>
        Правила судейства
        <select name="rules" defaultValue="FIG">
          <option value="FIG">FIG: D + E</option>
          <option value="CUSTOM">Свои: база 10 минус сбавки</option>
        </select>
      </label>
      <button type="submit" className="primary" disabled={busy}>
        {busy ? "Создаю…" : "Создать пробный турнир"}
      </button>
      {done && (
        <p className="wide">
          Пробный турнир создан и выбран. QR-коды старших судей уже на экране «Судьи»: по одному планшету на снаряд,
          другим судьям коды не нужны. После репетиции удалите турнир кнопкой «Удалить турнир» ниже на этом экране.
        </p>
      )}
    </form>
  );
}

/** Участники: вставка списка из таблицы и проверка перед загрузкой. */
export function RosterPanel({
  competitionId,
  discipline,
  partner,
  teamFormat,
  adminToken,
  onError,
  onImported,
}: Props & {
  teamFormat: TeamFormat;
  onImported?: () => void;
  /** Вторая часть турнира девочек и мальчиков: список делится между частями по столбцу «Пол». */
  partner?: { id: string; discipline: Discipline } | undefined;
}) {
  const [text, setText] = useState("");
  const [people, setPeople] = useState<RosterGymnast[]>([]);
  const [teams, setTeams] = useState<Map<string, string>>(new Map());
  const [categories, setCategories] = useState<Map<string, string>>(new Map());
  const [fileNotes, setFileNotes] = useState<string[]>([]);
  const parsed = useMemo(() => parseRoster(text), [text]);
  const warnings = useMemo(() => {
    // Команда считается внутри своего разряда.
    const label = (team: string, category: string | undefined) => (category ? `${team}, ${category}` : team);
    const sizes = new Map<string, number>();
    const add = (key: string) => sizes.set(key, (sizes.get(key) ?? 0) + 1);
    for (const g of people) {
      const name = g.teamId ? teams.get(g.teamId) : undefined;
      if (name) add(label(name, g.categoryId ? categories.get(g.categoryId) : undefined));
    }
    for (const r of parsed.rows) if (r.team) add(label(r.team, r.category));
    return teamFormatWarnings(sizes, teamFormat);
  }, [people, teams, categories, parsed.rows, teamFormat]);

  const load = useCallback(async () => {
    try {
      const [list, teamList, categoryList] = await Promise.all([
        apiRequest<RosterGymnast[]>(`/competitions/${competitionId}/gymnasts`),
        apiRequest<{ id: string; name: string }[]>(`/competitions/${competitionId}/teams`),
        apiRequest<{ id: string; name: string }[]>(`/competitions/${competitionId}/categories`),
      ]);
      setPeople(list);
      setTeams(new Map(teamList.map((t) => [t.id, t.name])));
      setCategories(new Map(categoryList.map((c) => [c.id, c.name])));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [competitionId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  // Заявка из Excel превращается в текст списка: его видно и можно поправить до загрузки.
  const readEntries = async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const result = await apiRequest<{ text: string; count: number; notes: string[] }>(
        `/competitions/${competitionId}/gymnasts/parse-xlsx`,
        {
          token: adminToken,
          method: "POST",
          body: { file: btoa(binary), nextBib: Math.max(0, ...parsed.rows.map((r) => r.bib)) + 1 },
        },
      );
      setText((current) => (current.trim() ? `${current.trimEnd()}\n${result.text}` : result.text));
      setFileNotes([`${file.name}: ${result.count} уч.`, ...result.notes]);
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const split = partner ? splitByGender(parsed.rows) : null;
  const upload = async () => {
    try {
      const send = (id: string, rows: unknown[]) =>
        rows.length > 0
          ? apiRequest(`/competitions/${id}/gymnasts/import`, { token: adminToken, method: "POST", body: { rows } })
          : Promise.resolve();
      if (split && partner) {
        if (split.missing.length > 0) throw new Error(`Не указан пол у №${split.missing.join(", №")}: впишите «Ж» или «М»`);
        const [mine, theirs] = discipline === "MAG" ? [split.boys, split.girls] : [split.girls, split.boys];
        await send(competitionId, mine);
        await send(partner.id, theirs);
      } else {
        await send(competitionId, parsed.rows.map(({ gender: _gender, ...row }) => row));
      }
      setText("");
      setFileNotes([]);
      onError(null);
      await load();
      onImported?.();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <section className="panel roster no-print">
      <h2>Участники: {people.length}</h2>
      <div className="wide entries-file">
        <label className="file">
          Загрузить заявку Excel
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void readEntries(file);
            }}
          />
        </label>
        <a href={`/competitions/${competitionId}/entries-template.xlsx`} download="Заявка.xlsx">
          Бланк заявки для клубов
        </a>
        <span className="muted">
          Столбцы узнаются по заголовкам: Фамилия, Имя (или ФИО), Отчество, Дата рождения, Клуб, Город, Тренер, Команда, Разряд, Смена, Стартовый номер, Пол.
          Заявки нескольких клубов можно загрузить по очереди, а потом добавить всех разом.
        </span>
      </div>
      {fileNotes.length > 0 && (
        <div className="warning wide">
          {fileNotes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      )}
      <ManualGymnastForm
        nextBib={Math.max(0, ...people.map((g) => g.bib), ...parsed.rows.map((r) => r.bib)) + 1}
        clubs={[...new Set(people.map((g) => g.club).filter((c): c is string => Boolean(c)))]}
        add={async (row) => {
          await apiRequest(`/competitions/${competitionId}/gymnasts/import`, {
            token: adminToken,
            method: "POST",
            body: { rows: [row] },
          });
          onError(null);
          await load();
          onImported?.();
        }}
        onError={onError}
      />
      <details className="wide paste-roster" open={text.trim() !== "" || undefined}>
        <summary>Вставить список из таблицы или проверить загруженную заявку Excel</summary>
        <label className="wide">
          Вставьте список из таблицы: № · Фамилия · Имя · Клуб · Команда · Разряд · Смена · Дата рождения · Город ·
          Тренер · Отчество · Пол. Обязательны первые три столбца{partner ? " и пол" : ""}. Порядок строк в смене — порядок выхода.
          <textarea
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"Например:\n12\tИванова\tАнна\tСШОР №1\tСШОР №1\t1 юношеский\t1\t15.03.2014\tТверь\tСмирнова О. В.\n13\tПетрова\tМария\tСШОР №1\tСШОР №1\t1 юношеский\t1\t2014\tТверь"}
          />
        </label>
        {parsed.errors.length > 0 && <div className="alert wide">{parsed.errors.join("; ")}</div>}
        {!text.trim() && (
          <p className="muted wide">Кнопка «Добавить из списка» включится, когда в поле появятся строки из таблицы.</p>
        )}
        {warnings.map((w) => (
          <div key={w} className="warning wide">
            {w}
          </div>
        ))}
        {split && (
          <p className={split.missing.length > 0 ? "alert wide" : "muted wide"}>
            Турнир девочек и мальчиков: последний столбец «Пол» (Ж или М) решает, в какую часть попадёт участник.
            {parsed.rows.length > 0 &&
              ` В списке девочек ${split.girls.length}, мальчиков ${split.boys.length}` +
                (split.missing.length > 0 ? `, без пола ${split.missing.length} (№${split.missing.join(", №")}).` : ".")}
          </p>
        )}
        <button
          type="button"
          className="primary"
          disabled={parsed.rows.length === 0 || parsed.errors.length > 0 || (split?.missing.length ?? 0) > 0}
          onClick={() => void upload()}
        >
          Добавить из списка {parsed.rows.length > 0 ? `${parsed.rows.length} уч.` : ""}
        </button>
      </details>
      <datalist id="category-names">
        {[...categories.values()].map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <datalist id="team-names">
        {[...new Set(teams.values())].map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      {people.length > 0 && (
        <details className="wide" open={people.some((g) => g.status !== "ACTIVE")}>
          <summary>
            Список участников: правка, неявка, снятие
            {people.some((g) => g.status !== "ACTIVE") &&
              ` (не выступают: ${people.filter((g) => g.status !== "ACTIVE").length})`}
          </summary>
          <table className="roster-table">
            <tbody>
              {people.map((g) => (
                <GymnastRow
                  key={g.id}
                  gymnast={g}
                  team={g.teamId ? (teams.get(g.teamId) ?? "") : ""}
                  category={g.categoryId ? (categories.get(g.categoryId) ?? "") : ""}
                  save={async (patch) => {
                    await apiRequest(`/competitions/${competitionId}/gymnasts/${g.id}`, {
                      token: adminToken,
                      method: "PATCH",
                      body: patch,
                    });
                    await load();
                    onImported?.();
                  }}
                  remove={async () => {
                    await apiRequest(`/competitions/${competitionId}/gymnasts/${g.id}`, {
                      token: adminToken,
                      method: "DELETE",
                    });
                    await load();
                    onImported?.();
                  }}
                  onError={onError}
                />
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

type RosterRow = ImportGymnastsInput["rows"][number];

/** Цифры даты рождения с точками по мере набора: 15032014 → 15.03.2014. */
const dateMask = (value: string) => {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join(".");
};

/** Настоящая дата в прошлом: 31.02 или 2040 год не пройдут. */
const validDate = (text: string) => {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (!m) return false;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(year, month - 1, day);
  return date.getDate() === day && date.getMonth() === month - 1 && year >= 1900 && date <= new Date();
};

const MANUAL_FIELDS = ["club", "city", "coach", "team", "category", "shift"] as const;

/**
 * Один участник вручную: обязательны фамилия, имя, полная дата рождения, клуб и тренер. После добавления фамилия, имя и отчество очищаются, номер растёт,
 * а клуб, город, тренер, команда, разряд и смена остаются: так удобно вносить клуб целиком.
 */
function ManualGymnastForm({
  nextBib,
  clubs,
  add,
  onError,
}: {
  nextBib: number;
  clubs: string[];
  add: (row: RosterRow) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [bib, setBib] = useState("");
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);

  const submit = async (data: FormData) => {
    const text = (name: string) => String(data.get(name) ?? "").trim();
    const bibValue = Number(bib || nextBib);
    const birthDate = text("birthDate");
    const shiftText = text("shift");
    if (!Number.isInteger(bibValue) || bibValue < 1) return onError("Номер участника — целое число от 1");
    if (!validDate(birthDate)) return onError("Укажите дату рождения полностью: день, месяц и год, например 15.03.2014");
    const shift = shiftText ? Number(shiftText) : undefined;
    if (shift !== undefined && !(Number.isInteger(shift) && shift >= 1 && shift <= 50)) {
      return onError("Смена — число от 1 до 50");
    }
    const row: RosterRow = {
      bib: bibValue,
      lastName: text("lastName"),
      firstName: text("firstName"),
      ...(text("middleName") ? { middleName: text("middleName") } : {}),
      birthDate,
      ...(shift !== undefined ? { shift } : {}),
    };
    for (const field of MANUAL_FIELDS) if (field !== "shift" && text(field)) row[field] = text(field);
    setBusy(true);
    try {
      await add(row);
      setAdded(`Добавлен №${row.bib} ${row.lastName} ${row.firstName}`);
      setBib("");
      for (const name of ["lastName", "firstName", "middleName", "birthDate"]) {
        const input = form.current?.elements.namedItem(name);
        if (input instanceof HTMLInputElement) input.value = "";
      }
      (form.current?.elements.namedItem("lastName") as HTMLInputElement | null)?.focus();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      ref={form}
      className="wide manual-gymnast"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(new FormData(e.currentTarget));
      }}
    >
      <h3>Добавить участника вручную</h3>
      <p className="muted manual-gymnast-hint">
        Обязательны фамилия, имя, дата рождения, клуб и тренер. Клуб, город, тренер, команда, разряд и смена остаются после
        добавления, чтобы следующего участника того же клуба вносить быстрее.
      </p>
      <label>
        №
        <input inputMode="numeric" value={bib} placeholder={String(nextBib)} onChange={(e) => setBib(e.target.value)} />
      </label>
      <label>
        Фамилия
        <input name="lastName" required maxLength={100} />
      </label>
      <label>
        Имя
        <input name="firstName" required maxLength={100} />
      </label>
      <label>
        Отчество (если есть)
        <input name="middleName" maxLength={100} />
      </label>
      <label>
        Дата рождения
        <input
          name="birthDate"
          required
          inputMode="numeric"
          placeholder="дд.мм.гггг"
          maxLength={10}
          onChange={(e) => (e.currentTarget.value = dateMask(e.currentTarget.value))}
        />
      </label>
      <label>
        Клуб
        <input name="club" list="club-names" required maxLength={200} />
      </label>
      <label>
        Город
        <input name="city" maxLength={200} />
      </label>
      <label>
        Тренер
        <input name="coach" required maxLength={200} placeholder="напр. Смирнова О. В." />
      </label>
      <label>
        Команда
        <input name="team" list="team-names" maxLength={200} />
      </label>
      <label>
        Разряд
        <input name="category" list="category-names" maxLength={100} />
      </label>
      <label>
        Смена
        <input name="shift" inputMode="numeric" />
      </label>
      <datalist id="club-names">
        {clubs.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <div className="manual-gymnast-actions">
        <button type="submit" className="primary" disabled={busy}>
          Добавить участника
        </button>
        {added && <span className="muted">{added}</span>}
      </div>
    </form>
  );
}

interface BaseDraft {
  base: string;
  apparatus: Record<string, string>;
}

const scoreText = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));
const readScore = (text: string) => {
  const t = text.trim().replace(",", ".");
  if (!t) return null;
  return parseScore(t, "D");
};

/**
 * Правила судейства. FIG — оценка D плюс E. Свои правила (юношеские разряды,
 * школьные и региональные старты): у разряда базовая оценка, из неё вычитаются
 * сбавки за требования, средняя сбавка судей E и нейтральная сбавка.
 */
export function RulesPanel({
  competitionId,
  discipline,
  adminToken,
  onError,
  onSaved,
}: Props & { onSaved: (rules: Rules) => void }) {
  const [view, setView] = useState<RulesView | null>(null);
  const [rules, setRules] = useState<Rules>("FIG");
  const [deductions, setDeductions] = useState<{ name: string; value: string }[]>([]);
  const [bases, setBases] = useState<Record<string, BaseDraft>>({});
  const { saved, markSaved, watch } = useSaved();
  const program = apparatusFor(discipline);

  const apply = useCallback((v: RulesView) => {
    setView(v);
    setRules(v.rules);
    setDeductions(v.deductions.map((d) => ({ name: d.name, value: String(d.value) })));
    setBases(
      Object.fromEntries(
        v.categories.map((c) => [
          c.id,
          {
            base: scoreText(c.base),
            apparatus: Object.fromEntries(Object.entries(c.apparatus).map(([a, n]) => [a, scoreText(n)])),
          },
        ]),
      ),
    );
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await apiRequest<RulesView>(`/competitions/${competitionId}/rules`));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [competitionId, apply, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const problems: string[] = [];
  const deductionRows = deductions
    .filter((d) => d.name.trim() || d.value.trim())
    .map((d) => {
      const value = readScore(d.value);
      if (!d.name.trim() || value === null || value <= 0 || value > 10) {
        problems.push(`Сбавка «${d.name || "без названия"}»: нужны название и значение от 0.001 до 10`);
      }
      return { name: d.name.trim(), value: value ?? 0 };
    });
  const baseRows = (view?.categories ?? []).map((c) => {
    const draft = bases[c.id] ?? { base: "", apparatus: {} };
    const base = readScore(draft.base);
    if (draft.base.trim() && base === null) problems.push(`База разряда «${c.name}»: число до 20`);
    const apparatus: Record<string, number> = {};
    for (const [a, text] of Object.entries(draft.apparatus)) {
      if (!text.trim()) continue;
      const n = readScore(text);
      if (n === null) problems.push(`База разряда «${c.name}», ${APPARATUS_NAMES[a]}: число до 20`);
      else apparatus[a] = n;
    }
    return { categoryId: c.id, base, apparatus };
  });
  const missing =
    rules === "CUSTOM"
      ? (view?.categories ?? []).filter((c, i) => {
          const row = baseRows[i]!;
          return row.base === null && program.some((a) => row.apparatus[a] === undefined);
        })
      : [];

  const save = async () => {
    try {
      const result = await apiRequest<RulesView>(`/competitions/${competitionId}/rules`, {
        token: adminToken,
        method: "PUT",
        body: { rules, deductions: deductionRows, bases: rules === "CUSTOM" ? baseRows : [] },
      });
      apply(result);
      onSaved(result.rules);
      onError(null);
      markSaved();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const setBase = (id: string, change: (d: BaseDraft) => BaseDraft) =>
    setBases((all) => ({ ...all, [id]: change(all[id] ?? { base: "", apparatus: {} }) }));

  if (!view) return null;
  return (
    <section className="panel no-print rules" {...watch}>
      <h2>Правила судейства</h2>
      <label className="wide">
        <select value={rules} disabled={view.scored} onChange={(e) => setRules(e.target.value as Rules)}>
          <option value="FIG">FIG: итог = D + E − нейтральная сбавка</option>
          <option value="CUSTOM">Свои: итог = база разряда − требования − сбавка E − нейтральная</option>
        </select>
        {view.scored && <span className="muted">Оценки уже ставятся: правила не переключить.</span>}
      </label>

      {rules === "CUSTOM" && (
        <>
          <div className="wide">
            <h3>Базовые оценки по разрядам</h3>
            {view.categories.length === 0 ? (
              <p className="muted">Разряды появятся, когда вы загрузите участников со столбцом «Разряд».</p>
            ) : (
              <table className="rules-table">
                <thead>
                  <tr>
                    <th>Разряд</th>
                    <th>База</th>
                    <th>Своя база на снарядах (если отличается)</th>
                  </tr>
                </thead>
                <tbody>
                  {view.categories.map((c) => {
                    const draft = bases[c.id] ?? { base: "", apparatus: {} };
                    return (
                      <tr key={c.id}>
                        <td>
                          {c.name}
                          {c.scored && <div className="muted">есть оценки</div>}
                        </td>
                        <td>
                          <input
                            inputMode="decimal"
                            placeholder="впишите"
                            className={draft.base.trim() ? undefined : "missing"}
                            value={draft.base}
                            disabled={c.scored}
                            onChange={(e) => setBase(c.id, (d) => ({ ...d, base: e.target.value }))}
                          />
                        </td>
                        <td>
                          <details open={Object.keys(draft.apparatus).length > 0}>
                            <summary>по снарядам</summary>
                            {program.map((a) => (
                              <label key={a} className="inline">
                                {APPARATUS_NAMES[a]}{" "}
                                <input
                                  inputMode="decimal"
                                  placeholder={draft.base || "—"}
                                  value={draft.apparatus[a] ?? ""}
                                  disabled={c.scored}
                                  onChange={(e) =>
                                    setBase(c.id, (d) => ({
                                      ...d,
                                      apparatus: { ...d.apparatus, [a]: e.target.value },
                                    }))
                                  }
                                />
                              </label>
                            ))}
                          </details>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {missing.length > 0 && (
              <div className="warning">
                Не задана база: {missing.map((c) => c.name).join(", ")}. Оценки участникам этих разрядов не
                утвердятся.
              </div>
            )}
          </div>

          <div className="wide">
            <h3>Сбавки за требования</h3>
            <p className="muted">
              Кнопки на планшете судьи: нажатие прибавляет сбавку. Любую другую сумму судья может ввести вручную.
            </p>
            {deductions.map((d, i) => (
              <div key={i} className="deduction-row">
                <input
                  type="text"
                  placeholder="Например: отсутствие элемента"
                  value={d.name}
                  onChange={(e) =>
                    setDeductions((list) => list.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))
                  }
                />
                <input
                  inputMode="decimal"
                  placeholder="0.5"
                  value={d.value}
                  onChange={(e) =>
                    setDeductions((list) => list.map((x, k) => (k === i ? { ...x, value: e.target.value } : x)))
                  }
                />
                <button
                  type="button"
                  className="link"
                  onClick={() => setDeductions((list) => list.filter((_, k) => k !== i))}
                >
                  Убрать
                </button>
              </div>
            ))}
            <button type="button" onClick={() => setDeductions((list) => [...list, { name: "", value: "" }])}>
              Добавить сбавку
            </button>
          </div>
        </>
      )}

      {problems.length > 0 && <div className="alert wide">{problems.join("; ")}</div>}
      <SaveButton saved={saved} disabled={problems.length > 0} onClick={() => void save()}>
        Сохранить правила
      </SaveButton>
    </section>
  );
}

interface DrawGymnast extends RosterGymnast {
  startOrder: number | null;
}

/**
 * Смены: секретариат делит участников на смены (разряды целиком или поровну)
 * или убирает смены, и тогда все выступают вместе. Только до первых оценок.
 */
export function ShiftsPanel({
  competitionId,
  adminToken,
  onError,
  onChanged,
}: Omit<Props, "discipline"> & { onChanged: () => void }) {
  const [people, setPeople] = useState<RosterGymnast[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [started, setStarted] = useState(false);
  const [mode, setMode] = useState<"none" | "split">("none");
  const [count, setCount] = useState("2");
  const [byCategory, setByCategory] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, categoryList, draw] = await Promise.all([
        apiRequest<RosterGymnast[]>(`/competitions/${competitionId}/gymnasts`),
        apiRequest<{ id: string; name: string }[]>(`/competitions/${competitionId}/categories`),
        apiRequest<DrawView>(`/competitions/${competitionId}/draw`, { token: adminToken }),
      ]);
      setPeople(list);
      setCategories(categoryList);
      setStarted(draw.started);
      const shifts = new Set(list.map((g) => g.shift).filter((n) => n !== null));
      setMode(shifts.size > 0 ? "split" : "none");
      if (shifts.size > 0) setCount(String(shifts.size));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [competitionId, adminToken, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (people.length === 0) return null;
  const categoryCount = categories.length;
  const numbers = [...new Set(people.map((g) => g.shift).filter((n): n is number => n !== null))].sort((a, b) => a - b);
  // Какие разряды в каждой смене и сколько в них участников — в порядке разрядов.
  const current = numbers.map((number) => {
    const members = people.filter((g) => g.shift === number);
    const parts = [...categories, { id: null, name: "без разряда" }]
      .map((c) => ({ name: c.name, size: members.filter((g) => (g.categoryId ?? null) === c.id).length }))
      .filter((c) => c.size > 0);
    return { number, size: members.length, parts };
  });
  const withoutShift = people.filter((g) => g.shift === null).length;
  const n = Number(count);
  const valid = mode === "none" || (Number.isInteger(n) && n >= 1 && n <= 20);

  const apply = async () => {
    const shifts = mode === "none" ? 0 : n;
    const question =
      shifts === 0
        ? "Убрать смены? Все участники будут выступать вместе, судьи увидят на снаряде весь список."
        : `Разделить ${people.length} уч. на ${shifts} ${shifts === 1 ? "смену" : shifts < 5 ? "смены" : "смен"} (${byCategory ? "разряды целиком" : "поровну"})? Смены из таблицы заменятся.`;
    if (!confirm(question)) return;
    setBusy(true);
    try {
      await apiRequest<RotationView>(`/competitions/${competitionId}/shifts/distribute`, {
        token: adminToken,
        method: "POST",
        body: { shifts, byCategory },
      });
      onError(null);
      await load();
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel no-print shifts-panel">
      <h2>Смены</h2>
      {current.length === 0 ? (
        <p className="wide">
          Сейчас: <strong>без смен, все выступают вместе</strong>
        </p>
      ) : (
        <div className="wide table-scroll">
          <table className="draw-table shift-summary">
            <thead>
              <tr>
                <th>Смена</th>
                <th className="num">Участников</th>
                <th>Разряды</th>
              </tr>
            </thead>
            <tbody>
              {current.map((s) => (
                <tr key={s.number}>
                  <td>{s.number}</td>
                  <td className="num">{s.size}</td>
                  <td>{s.parts.map((c) => `${c.name} (${c.size})`).join(", ")}</td>
                </tr>
              ))}
              {withoutShift > 0 && (
                <tr>
                  <td className="warning-text">без смены</td>
                  <td className="num warning-text">{withoutShift}</td>
                  <td className="muted">укажите смену в карточке участника или разделите заново</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="wide shift-modes">
        <label className="check">
          <input type="radio" name="shift-mode" checked={mode === "none"} onChange={() => setMode("none")} />
          Без смен: все участники выступают вместе, судьи на снаряде видят весь список
        </label>
        <label className="check">
          <input type="radio" name="shift-mode" checked={mode === "split"} onChange={() => setMode("split")} />
          Разделить на смены: смены переходят со снаряда на снаряд по ротациям
        </label>
      </div>
      {mode === "split" && (
        <>
          <label>
            Сколько смен
            <input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
          </label>
          <label>
            Как делить
            <select value={byCategory ? "category" : "even"} onChange={(e) => setByCategory(e.target.value === "category")}>
              <option value="category">Разряды целиком{categoryCount > 0 ? ` (разрядов: ${categoryCount})` : ""}</option>
              <option value="even">Поровну, команда не разрывается</option>
            </select>
          </label>
        </>
      )}
      <div className="buttons wide">
        <button type="button" className="primary" disabled={!valid || busy || started} onClick={() => void apply()}>
          {mode === "none" ? "Убрать смены" : "Разделить на смены"}
        </button>
      </div>
      <p className="muted wide">
        {started
          ? "Соревнование уже идёт: после первых оценок смены не меняют."
          : "Смены можно задать и в таблице участников (столбец «Смена»). Отдельному участнику смену меняют в его карточке."}
      </p>
    </section>
  );
}

/**
 * Жеребьёвка стартовых номеров до начала соревнований: случайная или ручная.
 * Порядок выхода в смене — по возрастанию номеров.
 */
export function DrawPanel({
  competitionId,
  adminToken,
  onError,
  onDrawn,
}: Omit<Props, "discipline"> & { onDrawn: () => void }) {
  const [view, setView] = useState<DrawView | null>(null);
  const [people, setPeople] = useState<DrawGymnast[]>([]);
  const [closedShifts, setClosedShifts] = useState<Set<string>>(new Set());
  const [teams, setTeams] = useState<Map<string, string>>(new Map());
  const [categories, setCategories] = useState<Map<string, string>>(new Map());
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [firstBib, setFirstBib] = useState("1");
  const [keepTeams, setKeepTeams] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [drawView, list, teamList, categoryList] = await Promise.all([
        apiRequest<DrawView>(`/competitions/${competitionId}/draw`, { token: adminToken }),
        apiRequest<DrawGymnast[]>(`/competitions/${competitionId}/gymnasts`),
        apiRequest<{ id: string; name: string }[]>(`/competitions/${competitionId}/teams`),
        apiRequest<{ id: string; name: string }[]>(`/competitions/${competitionId}/categories`),
      ]);
      setView(drawView);
      // Как выйдут на старт: по сменам, внутри смены по порядку выхода.
      const last = Number.MAX_SAFE_INTEGER;
      setPeople(
        [...list].sort(
          (a, b) =>
            (a.shift ?? last) - (b.shift ?? last) ||
            (a.startOrder ?? last) - (b.startOrder ?? last) ||
            a.bib - b.bib,
        ),
      );
      setTeams(new Map(teamList.map((t) => [t.id, t.name])));
      setCategories(new Map(categoryList.map((c) => [c.id, c.name])));
      setEdits({});
    } catch (e) {
      onError((e as Error).message);
    }
  }, [competitionId, adminToken, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const bibOf = (g: DrawGymnast) => edits[g.id] ?? String(g.bib);
  const invalid = people.filter((g) => !/^\d{1,6}$/.test(bibOf(g).trim()) || Number(bibOf(g)) < 1);
  const counts = new Map<string, number>();
  for (const g of people) counts.set(bibOf(g).trim(), (counts.get(bibOf(g).trim()) ?? 0) + 1);
  const repeated = people.filter((g) => (counts.get(bibOf(g).trim()) ?? 0) > 1);
  const changed = people.filter((g) => edits[g.id] !== undefined && Number(edits[g.id]) !== g.bib);
  const locked = view?.started ?? false;

  const run = async (body: object, question: string) => {
    if (!confirm(question)) return;
    setBusy(true);
    try {
      await apiRequest(`/competitions/${competitionId}/draw`, { token: adminToken, method: "POST", body });
      onError(null);
      await load();
      onDrawn();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!view || people.length === 0) return null;
  // Смены — карточками в один ряд, каждую можно свернуть.
  const shiftGroups: { key: string; title: string; members: DrawGymnast[] }[] = [];
  for (const g of people) {
    const key = g.shift === null ? "none" : String(g.shift);
    const last = shiftGroups[shiftGroups.length - 1];
    if (last?.key === key) last.members.push(g);
    else shiftGroups.push({ key, title: g.shift === null ? "Без смены" : `Смена ${g.shift}`, members: [g] });
  }
  const first = Number(firstBib);
  const firstValid = Number.isInteger(first) && first >= 1 && first <= 100_000;

  return (
    <section className="panel no-print draw">
      <h2>Жеребьёвка</h2>
      <p className="muted wide">
        {view.last
          ? `Последняя жеребьёвка: ${view.last.mode === "random" ? "случайная" : "ручная"}, ${new Date(view.last.at).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}. `
          : "Жеребьёвку ещё не проводили. "}
        {locked
          ? "Оценки уже ставятся: номера больше не меняются."
          : "Порядок выхода в смене — по возрастанию стартовых номеров."}
      </p>

      {!locked && (
        <div className="wide draw-random">
          <h3>Случайная</h3>
          <label>
            Номера с
            <input inputMode="numeric" value={firstBib} onChange={(e) => setFirstBib(e.target.value.trim())} />
          </label>
          <label className="check">
            <input type="checkbox" checked={keepTeams} onChange={(e) => setKeepTeams(e.target.checked)} />
            Участники одной команды выступают подряд
          </label>
          <button
            type="button"
            className="primary"
            disabled={busy || !firstValid}
            onClick={() =>
              void run(
                { mode: "random", firstBib: first, keepTeams },
                `Провести жеребьёвку? Все ${people.length} уч. получат новые номера с №${first} в случайном порядке внутри своей смены.`,
              )
            }
          >
            Провести жеребьёвку
          </button>
        </div>
      )}

      <div className="wide">
        {!locked && (
          <h3>
            Вручную <span className="muted">— впишите номера и сохраните</span>
          </h3>
        )}
        <div className="draw-shifts">
          {shiftGroups.map(({ key, title, members }) => {
            const bad = members.some((g) => repeated.includes(g) || invalid.includes(g));
            const shiftCategories = [
              ...new Set(members.map((g) => (g.categoryId ? categories.get(g.categoryId) : null)).filter(Boolean)),
            ];
            return (
              <details
                key={key}
                className="draw-shift"
                open={bad || !closedShifts.has(key)}
                onToggle={(ev) => {
                  const closed = !ev.currentTarget.open;
                  setClosedShifts((set) => {
                    if (set.has(key) === closed) return set;
                    const next = new Set(set);
                    if (closed) next.add(key);
                    else next.delete(key);
                    return next;
                  });
                }}
              >
                <summary>
                  <strong>{title}</strong>
                  <span className="muted">
                    {" "}
                    · {members.length} уч.{shiftCategories.length > 0 ? ` · ${shiftCategories.join(", ")}` : ""}
                  </span>
                  {bad && <span className="draw-shift-bad"> · проверьте номера</span>}
                </summary>
                <table className="draw-table draw-list">
                  <thead>
                    <tr>
                      <th>№</th>
                      <th>Участник</th>
                      <th>Клуб · команда</th>
                      <th>Разряд</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((g) => (
                      <tr key={g.id} className={repeated.includes(g) || invalid.includes(g) ? "invalid" : undefined}>
                        <td>
                          <input
                            inputMode="numeric"
                            disabled={locked}
                            value={bibOf(g)}
                            onChange={(e) => setEdits((all) => ({ ...all, [g.id]: e.target.value }))}
                          />
                        </td>
                        <td>
                          {g.lastName} {g.firstName}
                        </td>
                        <td className="muted">
                          {[g.club, g.teamId ? teams.get(g.teamId) : null].filter(Boolean).join(" · ")}
                        </td>
                        <td className="muted">{g.categoryId ? categories.get(g.categoryId) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            );
          })}
        </div>
        {repeated.length > 0 && (
          <div className="alert">
            Номера повторяются: {[...new Set(repeated.map((g) => bibOf(g).trim()))].map((b) => `№${b}`).join(", ")}
          </div>
        )}
        {!locked && (
          <button
            type="button"
            className="primary"
            disabled={busy || changed.length === 0 || repeated.length > 0 || invalid.length > 0}
            onClick={() =>
              void run(
                { mode: "manual", bibs: changed.map((g) => ({ gymnastId: g.id, bib: Number(bibOf(g)) })) },
                `Сохранить новые номера у ${changed.length} уч.?`,
              )
            }
          >
            Сохранить номера{changed.length > 0 ? ` (${changed.length})` : ""}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * Финалы на отдельных снарядах: отбор лучших по квалификации в каждом разряде,
 * жеребьёвка порядка выступления, замена запасными и переключение этапа.
 */
export function FinalsPanel({ competitionId, adminToken, onError }: Omit<Props, "discipline">) {
  const [view, setView] = useState<FinalsView | null>(null);
  const [size, setSize] = useState("8");
  const [reserves, setReserves] = useState("2");
  const [perClub, setPerClub] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const finals = await apiRequest<FinalsView>(`/competitions/${competitionId}/finals`);
      setView(finals);
      setSize(String(finals.size));
      setReserves(String(finals.reserves));
      setPerClub(finals.perClub === null ? "" : String(finals.perClub));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [competitionId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (path: string, body: object, question?: string) => {
    if (question && !confirm(question)) return;
    setBusy(true);
    try {
      setView(await apiRequest<FinalsView>(`/competitions/${competitionId}/finals${path}`, { token: adminToken, method: "POST", body }));
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!view) return null;
  const sizeN = Number(size);
  const reservesN = Number(reserves);
  const perClubN = perClub ? Number(perClub) : null;
  const valid =
    Number.isInteger(sizeN) && sizeN >= 1 && sizeN <= 16 &&
    Number.isInteger(reservesN) && reservesN >= 0 && reservesN <= 5 &&
    (perClubN === null || (Number.isInteger(perClubN) && perClubN >= 1 && perClubN <= 16));
  const isFinal = view.phase === "FINAL";
  const hasFinals = view.lists.length > 0;

  return (
    <section className="panel no-print finals">
      <h2>Финалы на снарядах</h2>
      <p className="muted wide">
        В каждом разряде на каждом снаряде в финал выходят лучшие по оценкам квалификации; разделившие последнее
        проходное место проходят все. Порядок выступления — жеребьёвка. Многоборье и команды считаются только
        по квалификации.
      </p>
      {!view.started && (
        <div className="wide draw-random">
          <label>
            Финалистов
            <input inputMode="numeric" value={size} onChange={(e) => setSize(e.target.value.trim())} />
          </label>
          <label>
            Запасных
            <input inputMode="numeric" value={reserves} onChange={(e) => setReserves(e.target.value.trim())} />
          </label>
          <label>
            Не больше от клуба
            <input inputMode="numeric" placeholder="без огр." value={perClub} onChange={(e) => setPerClub(e.target.value.trim())} />
          </label>
          <button
            type="button"
            className="primary"
            disabled={busy || !valid}
            onClick={() =>
              void post(
                "",
                { size: sizeN, reserves: reservesN, perClub: perClubN },
                hasFinals
                  ? "Пересобрать финалы? Состав и порядок выступления будут определены заново."
                  : "Сформировать финалы по утверждённым оценкам квалификации?",
              )
            }
          >
            {hasFinals ? "Пересобрать финалы" : "Сформировать финалы"}
          </button>
        </div>
      )}
      <div className="wide finals-phase">
        <span>
          Сейчас идёт: <strong>{isFinal ? "финалы" : "квалификация"}</strong>
          {isFinal && <span className="muted"> · судьи вызывают только финалистов</span>}
        </span>
        {(hasFinals || isFinal) && (
          <button
            type="button"
            className={isFinal ? undefined : "primary"}
            disabled={busy}
            onClick={() =>
              void post(
                "/phase",
                { phase: isFinal ? "QUAL" : "FINAL" },
                isFinal
                  ? "Вернуться к квалификации? Судьи снова будут вызывать участников по сменам."
                  : "Начать финалы? Планшеты судей переключатся на списки финалистов.",
              )
            }
          >
            {isFinal ? "Вернуться к квалификации" : "Начать финалы"}
          </button>
        )}
      </div>
      {view.lists.map((l) => {
        const main = l.finalists.filter((f) => !f.reserve);
        const spare = l.finalists.filter((f) => f.reserve);
        return (
          <div key={`${l.apparatus}-${l.category.id}`} className="wide">
            <h3>
              {APPARATUS_NAMES[l.apparatus]}
              {l.category.name && <span className="muted"> · {l.category.name}</span>}
            </h3>
            <table className="draw-table">
              <tbody>
                {main.map((f) => (
                  <tr key={f.gymnast.id}>
                    <td>{f.position}.</td>
                    <td>№{f.gymnast.bib}</td>
                    <td>
                      {f.gymnast.lastName} {f.gymnast.firstName}
                    </td>
                    <td className="muted">{f.gymnast.club ?? ""}</td>
                    <td className="muted">
                      квал.: {f.qualRank} место, {fmt(f.qualTotal)}
                    </td>
                    <td>
                      {spare.length > 0 && (
                        <button
                          type="button"
                          className="link"
                          disabled={busy}
                          onClick={() =>
                            void post(
                              `/${l.apparatus}/replace`,
                              { gymnastId: f.gymnast.id },
                              `Снять с финала: ${f.gymnast.lastName} ${f.gymnast.firstName}? Место в порядке выступления займёт первый запасной.`,
                            )
                          }
                        >
                          Заменить запасным
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {spare.length > 0 && (
              <p className="muted">
                Запасные:{" "}
                {spare
                  .map((f) => `${f.position}. №${f.gymnast.bib} ${f.gymnast.lastName} ${f.gymnast.firstName} (${fmt(f.qualTotal)})`)
                  .join("; ")}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** «20 17 15 14» или «20, 17, 15» → [20, 17, 15]; null — в строке ошибка. */

const ENTRY_STATUS_NAMES = { NEW: "новая", ACCEPTED: "принята", REJECTED: "отклонена" } as const;

/** Значение для поля datetime-local в местном времени. */
function localInput(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

const longTime = (iso: string) => new Date(iso).toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" });

/**
 * Онлайн-заявки клубов: секретарь открывает приём, рассылает клубам ссылку,
 * забирает присланные заявки и принимает их в список участников.
 */
export function OnlineEntriesPanel({
  competitionId,
  adminToken,
  onError,
  onAccepted,
}: Omit<Props, "discipline"> & { onAccepted: () => void }) {
  const [view, setView] = useState<OnlineEntriesView | null>(null);
  const [deadline, setDeadline] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const run = useCallback(
    async (path: string, method: "GET" | "POST" | "PUT" = "GET", body?: unknown) => {
      setBusy(true);
      try {
        const next = await apiRequest<OnlineEntriesView>(`/competitions/${competitionId}/online-entries${path}`, {
          token: adminToken,
          method,
          ...(body === undefined ? {} : { body }),
        });
        setView(next);
        setDeadline(localInput(next.deadline));
        onError(null);
        return true;
      } catch (e) {
        onError((e as Error).message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [competitionId, adminToken, onError],
  );

  useEffect(() => {
    void run("");
  }, [run]);

  if (!view) return null;
  if (!view.enabled) {
    return (
      <section className="panel no-print online-entries">
        <h2>Онлайн-заявки клубов</h2>
        <p className="muted wide">
          Клубы могут подавать заявки по ссылке на сайте соревнований, когда сервер в зале подключён к сайту (переменные
          RELAY_URL и RELAY_TOKEN). Пока заявки загружаются из Excel или вставляются списком.
        </p>
      </section>
    );
  }

  const settings = (open: boolean) =>
    void run("/settings", "PUT", { open, deadline: open && deadline ? new Date(deadline).toISOString() : null });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(view.link!);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onError("Не удалось скопировать: выделите ссылку и скопируйте вручную");
    }
  };
  const fresh = view.entries.filter((e) => e.status === "NEW").length;

  return (
    <section className="panel no-print online-entries">
      <h2>Онлайн-заявки клубов</h2>
      <p className="muted wide">
        Откройте приём и отправьте клубам ссылку: заявку заполняют на сайте с телефона или компьютера. Присланное попадает
        сюда по кнопке «Забрать заявки», а в список участников — только после «Принять в список».
      </p>
      <p className="wide">
        {view.open ? (
          <strong>Приём открыт{view.deadline ? ` до ${longTime(view.deadline)}` : ""}.</strong>
        ) : (
          <strong>Приём закрыт.</strong>
        )}
      </p>
      <label>
        Принимать до (необязательно)
        <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
      </label>
      <div className="buttons">
        <button type="button" className="primary" disabled={busy} onClick={() => settings(true)}>
          {view.open ? "Сохранить срок" : "Открыть приём"}
        </button>
        {view.open && (
          <button type="button" disabled={busy} onClick={() => settings(false)}>
            Закрыть приём
          </button>
        )}
        {view.link && (
          <button type="button" disabled={busy} onClick={() => void run("/sync", "POST")}>
            Забрать заявки
          </button>
        )}
      </div>
      {view.link && (
        <div className="wide entry-link">
          <input readOnly value={view.link} aria-label="Ссылка для клубов" onFocus={(e) => e.target.select()} />
          <button type="button" onClick={() => void copy()}>
            {copied ? "Скопировано" : "Скопировать ссылку"}
          </button>
        </div>
      )}
      {view.syncedAt && (
        <p className="muted wide">
          Заявки забраны {longTime(view.syncedAt)}: всего {view.entries.length}, новых {fresh}.
        </p>
      )}
      {[...view.entries].reverse().map((e) => (
        <article key={e.id} className={`wide entry-card status-${e.status.toLowerCase()}`}>
          <header>
            <strong>{e.club}</strong>
            {e.city && <span className="muted"> · {e.city}</span>}
            <span className={`entry-status ${e.status.toLowerCase()}`}>{ENTRY_STATUS_NAMES[e.status]}</span>
          </header>
          <p className="muted">
            {e.contact} · получена {longTime(e.receivedAt)} · участников: {e.rows.length}
          </p>
          {e.comment && <p>Комментарий: {e.comment}</p>}
          {e.note && <p className="muted">Причина отказа: {e.note}</p>}
          <div className="table-scroll">
            <table className="draw-table">
              <thead>
                <tr>
                  <th>№</th>
                  <th>Участник</th>
                  <th>Дата рождения</th>
                  <th>Разряд</th>
                  <th>Команда</th>
                  <th>Тренер</th>
                </tr>
              </thead>
              <tbody>
                {e.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="muted">{i + 1}</td>
                    <td>{[r.lastName, r.firstName, r.middleName].filter(Boolean).join(" ")}</td>
                    <td>{r.birthDate ?? ""}</td>
                    <td>{r.category ?? ""}</td>
                    <td>{r.team ?? ""}</td>
                    <td>{r.coach ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {e.status === "NEW" && (
            <div className="buttons">
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() =>
                  void run(`/${e.id}/accept`, "POST").then((ok) => {
                    if (ok) onAccepted();
                  })
                }
              >
                Принять в список
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const note = window.prompt(`Отклонить заявку клуба «${e.club}»? Причина (необязательно):`);
                  if (note !== null) void run(`/${e.id}/reject`, "POST", note.trim() ? { note: note.trim() } : {});
                }}
              >
                Отклонить
              </button>
            </div>
          )}
        </article>
      ))}
    </section>
  );
}

interface SiteProtocolsView {
  enabled: boolean;
  published: ProtocolsIndex | null;
  page: string | null;
}

/**
 * Протоколы на сайте: секретарь одной кнопкой выкладывает итоговые протоколы
 * в PDF и Excel на сайт соревнований, где их скачивают клубы и зрители.
 */
export function SiteProtocolsPanel({ competitionId, adminToken, onError }: Omit<Props, "discipline">) {
  const [view, setView] = useState<SiteProtocolsView | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (method: "GET" | "POST" | "DELETE") => {
      setBusy(true);
      try {
        setView(await apiRequest<SiteProtocolsView>(`/competitions/${competitionId}/site-protocols`, { token: adminToken, method }));
        onError(null);
      } catch (e) {
        onError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [competitionId, adminToken, onError],
  );

  useEffect(() => {
    void run("GET");
  }, [run]);

  if (!view?.enabled) return null;
  const published = view.published;
  return (
    <section className="panel no-print site-protocols">
      <h2>Протоколы на сайте</h2>
      <p className="muted wide">
        Выкладывает на сайт соревнований протоколы каждого разряда (многоборье, снаряды, финалы, команды), общекомандный
        зачёт и итоги в Excel. Публикуется то, где есть утверждённые оценки. После правок нажмите кнопку ещё раз, и протоколы
        на сайте заменятся.
      </p>
      {published ? (
        <p className="wide">
          <strong>
            На сайте {published.files.length} файлов, выложены {longTime(published.publishedAt)}.
          </strong>{" "}
          {view.page && (
            <a href={view.page} target="_blank" rel="noopener">
              Открыть на сайте
            </a>
          )}
        </p>
      ) : (
        <p className="wide muted">Протоколы на сайт ещё не выкладывали.</p>
      )}
      <div className="buttons">
        <button type="button" className="primary" disabled={busy} onClick={() => void run("POST")}>
          {busy ? "Собираю протоколы…" : published ? "Обновить на сайте" : "Выложить на сайт"}
        </button>
        {published && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Снять протоколы с сайта?")) void run("DELETE");
            }}
          >
            Снять с сайта
          </button>
        )}
      </div>
    </section>
  );
}

interface SiteStatus {
  enabled: boolean;
  sentAt: string | null;
  error: string | null;
}

interface SiteView extends SiteStatus {
  page: string | null;
  embed: string | null;
}

/** «Сайт» в шапке секретариата: зелёный, если результаты доходят до сайта, красный с причиной, если нет. */
export function SiteBadge({ adminToken }: { adminToken: string }) {
  const [status, setStatus] = useState<SiteStatus | null>(null);
  useEffect(() => {
    if (!adminToken) return;
    let alive = true;
    const load = () =>
      apiRequest<SiteStatus>("/site", { token: adminToken })
        .then((s) => alive && setStatus(s))
        .catch(() => alive && setStatus(null));
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [adminToken]);

  if (!status?.enabled) return null;
  const ok = !status.error;
  const title = status.error
    ? `Результаты не доходят до сайта: ${status.error}`
    : status.sentAt
      ? `Результаты дошли до сайта ${longTime(status.sentAt)}`
      : "Сайт подключён. Турнир появится на сайте после первого вызова или кнопки «Отправить на сайт»";
  return (
    <div className="status site-badge" title={title}>
      <span className={ok ? "dot ok" : "dot down"} />
      {ok ? "Сайт" : "Сайт: нет связи"}
    </div>
  );
}

/**
 * Результаты на сайте: состояние отправки этого турнира, кнопка «Отправить на сайт сейчас»
 * и готовый код для вставки на страницу сайта.
 */
export function SitePanel({
  competitionId,
  adminToken,
  onError,
  competitions,
  partnerId,
}: Omit<Props, "discipline"> & {
  competitions: { id: string; name: string; discipline: string }[];
  /** Вторая часть турнира девочек и мальчиков: отправляется и встраивается вместе с этой. */
  partnerId?: string | undefined;
}) {
  const [view, setView] = useState<SiteView | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // Второе соревнование в той же рамке: девочки и мальчики с переключателем над табло.
  const [partner, setPartner] = useState(partnerId ?? "");
  const others = competitions.filter((c) => c.id !== competitionId);
  const embed =
    view?.embed && partner && others.some((c) => c.id === partner)
      ? view.embed.replace(
          `data-ag-results="${competitionId}"`,
          // Девочки первыми: так кнопки переключателя идут «Девочки | Мальчики».
          `data-ag-results="${[competitionId, partner]
            .sort((a, b) => Number(competitions.find((c) => c.id === b)?.discipline === "WAG") - Number(competitions.find((c) => c.id === a)?.discipline === "WAG"))
            .join(",")}"`,
        )
      : view?.embed;

  const run = useCallback(
    async (method: "GET" | "POST") => {
      setBusy(method === "POST");
      try {
        // Турнир девочек и мальчиков уходит на сайт целиком: сначала вторая часть.
        if (method === "POST" && partnerId) {
          await apiRequest(`/competitions/${partnerId}/site`, { token: adminToken, method });
        }
        setView(await apiRequest<SiteView>(`/competitions/${competitionId}/site`, { token: adminToken, method }));
        onError(null);
      } catch (e) {
        onError((e as Error).message);
        if (method === "POST") void run("GET");
      } finally {
        setBusy(false);
      }
    },
    [competitionId, partnerId, adminToken, onError],
  );

  useEffect(() => {
    void run("GET");
  }, [run]);

  if (!view) return null;
  if (!view.enabled) {
    return (
      <section className="panel no-print site-panel">
        <h2>Результаты на сайте</h2>
        <p className="muted wide">
          Сайт не подключён. Чтобы результаты шли на сайт, впишите адрес ретранслятора и его токен в файл .env
          (строки RELAY_URL и RELAY_TOKEN) и перезапустите программу.
        </p>
      </section>
    );
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(embed!);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onError("Не удалось скопировать: выделите код и скопируйте вручную");
    }
  };
  return (
    <section className="panel no-print site-panel">
      <h2>Результаты на сайте</h2>
      <p className="wide site-state">
        <span className={view.error ? "dot down" : view.sentAt ? "dot ok" : "dot idle"} />
        {view.error ? (
          <strong>Не доходят до сайта: {view.error}.</strong>
        ) : view.sentAt ? (
          <span>
            <strong>Турнир на сайте.</strong> Последняя отправка {longTime(view.sentAt)}.
          </span>
        ) : (
          <span>
            <strong>Турнира на сайте пока нет.</strong> Он появится после первого вызова участника или по кнопке ниже.
          </span>
        )}
      </p>
      <div className="buttons">
        <button type="button" className="primary" disabled={busy} onClick={() => void run("POST")}>
          {busy ? "Отправляю…" : view.sentAt ? "Отправить ещё раз" : "Отправить на сайт сейчас"}
        </button>
        {view.page && (
          <a className="button-link" href={view.page} target="_blank" rel="noopener">
            Открыть табло на сайте
          </a>
        )}
      </div>
      {embed && others.length > 0 && (
        <label className="wide site-partner">
          Показать в той же рамке с переключателем (например, девочки и мальчики)
          <select value={partner} onChange={(e) => setPartner(e.target.value)}>
            <option value="">Только это соревнование</option>
            {others.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.discipline})
              </option>
            ))}
          </select>
        </label>
      )}
      {embed && (
        <div className="wide site-embed">
          <span className="muted">Код для страницы сайта (блок «HTML» в Elementor):</span>
          <textarea readOnly rows={3} value={embed} onFocus={(e) => e.target.select()} aria-label="Код для страницы сайта" />
          <button type="button" onClick={() => void copy()}>
            {copied ? "Скопировано" : "Скопировать код"}
          </button>
        </div>
      )}
    </section>
  );
}

/** Больше записей в окне не держим: полный журнал — в PDF и Excel. */
const AUDIT_SHOWN = 1000;

/** «14:05:31», а для записей не сегодняшнего дня — с датой. */
function auditTime(iso: string): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return at.toDateString() === new Date().toDateString()
    ? time
    : `${at.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} ${time}`;
}

/**
 * Журнал изменений: кто и когда ставил и правил оценки, разбирал запросы,
 * менял участников и настройки. Выгружается для жюри в PDF и Excel.
 */
export function AuditPanel({ competitionId, adminToken, onError, active = true }: Omit<Props, "discipline"> & { active?: boolean }) {
  const [group, setGroup] = useState<AuditGroup | "">("");
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);

  const load = useCallback(async () => {
    try {
      const query = group ? `?group=${group}` : "";
      setEntries(await apiRequest<AuditEntry[]>(`/competitions/${competitionId}/audit${query}`, { token: adminToken }));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [competitionId, adminToken, group, onError]);

  // Свежие записи — каждый раз, когда открывают вкладку с журналом.
  useEffect(() => {
    if (active) void load();
  }, [load, active]);

  const download = async (pdf: boolean) => {
    const tab = pdf ? window.open("", "_blank") : null;
    const query = group ? `?group=${group}` : "";
    try {
      await fetchProtocol(competitionId, adminToken, `${pdf ? "audit" : "audit.xlsx"}${query}`, pdf ? "audit.pdf" : "audit.xlsx", tab);
      onError(null);
    } catch (e) {
      tab?.close();
      onError(e instanceof ApiError && e.status !== 0 ? e.message : "Нет связи с сервером");
    }
  };

  return (
    <section className="panel no-print audit">
      <h2>Журнал изменений</h2>
      <p className="muted wide">
        Кто и когда ставил, правил и утверждал оценки, разбирал запросы тренеров, менял участников и настройки. Новые записи
        сверху; в PDF и Excel — по порядку времени, для жюри.
      </p>
      <label>
        Раздел
        <select value={group} onChange={(e) => setGroup(e.target.value as AuditGroup | "")}>
          <option value="">Все записи</option>
          {AUDIT_GROUPS.map((g) => (
            <option key={g} value={g}>
              {AUDIT_GROUP_NAMES[g]}
            </option>
          ))}
        </select>
      </label>
      <div className="buttons">
        <button type="button" onClick={() => void load()}>
          Обновить
        </button>
        <button type="button" onClick={() => void download(true)}>
          Журнал в PDF
        </button>
        <button type="button" onClick={() => void download(false)}>
          Журнал в Excel
        </button>
      </div>
      {entries && entries.length === 0 && <p className="muted wide">Записей пока нет.</p>}
      {entries && entries.length > 0 && (
        <div className="wide table-scroll">
          <table className="draw-table audit-table">
            <thead>
              <tr>
                <th>Время</th>
                <th>Кто</th>
                <th>Снаряд</th>
                <th>Участник</th>
                <th>Что произошло</th>
              </tr>
            </thead>
            <tbody>
              {entries.slice(0, AUDIT_SHOWN).map((e) => (
                <tr key={e.id}>
                  <td className="muted">{auditTime(e.at)}</td>
                  <td>{e.actor}</td>
                  <td>
                    {e.apparatus && (
                      <>
                        <ApparatusIcon code={e.apparatus} /> {APPARATUS_NAMES[e.apparatus]}
                      </>
                    )}
                  </td>
                  <td>{e.gymnast ?? ""}</td>
                  <td>{e.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {entries && entries.length > 0 && (
        <p className="muted wide">
          Записей: {entries.length}
          {entries.length > AUDIT_SHOWN ? `, в окне последние ${AUDIT_SHOWN}; все — в PDF и Excel` : ""}.
        </p>
      )}
    </section>
  );
}

const CEREMONY_TITLES: Record<Ceremony["kind"], string> = {
  allAround: "Многоборье",
  apparatus: "Отдельный снаряд",
  teams: "Командный зачёт",
  clubs: "Общекомандный зачёт",
};

/** Награждение: секретариат выводит пьедестал на табло в зале и на сайт, затем убирает его. */
export function CeremonyPanel({ competitionId, discipline, adminToken, onError }: Props) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [draft, setDraft] = useState<{ kind: Ceremony["kind"]; category: string; apparatus: Apparatus }>({
    kind: "allAround",
    category: "",
    apparatus: apparatusFor(discipline)[0]!,
  });
  const [shown, setShown] = useState<CeremonyView | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiRequest<Category[]>(`/competitions/${competitionId}/results/categories`)
      .then((list) => {
        setCategories(list);
        setDraft((d) => ({ ...d, category: d.category || categoryParam(list[0]) }));
      })
      .catch(() => setCategories([]));
    apiRequest<BoardSnapshot>(`/competitions/${competitionId}/results/snapshot`)
      .then((snapshot) => setShown(snapshot.ceremony ?? null))
      .catch(() => setShown(null));
  }, [competitionId]);

  const send = async (ceremony: Ceremony | null) => {
    setBusy(true);
    try {
      const result = await apiRequest<{ ceremony: CeremonyView | null }>(`/competitions/${competitionId}/ceremony`, {
        token: adminToken,
        method: "PUT",
        body: { ceremony },
      });
      setShown(result.ceremony);
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const show = () =>
    void send({
      kind: draft.kind,
      categoryId: draft.kind === "clubs" || draft.category === "none" ? null : draft.category || null,
      ...(draft.kind === "apparatus" ? { apparatus: draft.apparatus } : {}),
    });

  return (
    <section className="panel no-print ceremony-panel">
      <h2>Награждение на табло</h2>
      <p className="muted wide">
        Табло в зале и на сайте в автоматическом режиме покажет пьедестал с призёрами, пока награждение не уберут. На
        снаряде награждают по финалу, если он был.
      </p>
      <label>
        Что награждаем
        <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Ceremony["kind"] })}>
          {(Object.keys(CEREMONY_TITLES) as Ceremony["kind"][]).map((k) => (
            <option key={k} value={k}>
              {CEREMONY_TITLES[k]}
            </option>
          ))}
        </select>
      </label>
      {draft.kind === "apparatus" && (
        <label>
          Снаряд
          <select value={draft.apparatus} onChange={(e) => setDraft({ ...draft, apparatus: e.target.value as Apparatus })}>
            {apparatusFor(discipline).map((a) => (
              <option key={a} value={a}>
                {APPARATUS_NAMES[a]}
              </option>
            ))}
          </select>
        </label>
      )}
      {draft.kind !== "clubs" && categories.some((c) => c.id) && (
        <label>
          Разряд
          <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
            {categories.map((c) => (
              <option key={categoryParam(c)} value={categoryParam(c)}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="button" className="primary" disabled={busy} onClick={show}>
        Показать на табло
      </button>
      {shown && (
        <div className="wide ceremony-shown">
          <p>
            Сейчас на табло: <strong>{shown.title}</strong>
          </p>
          {shown.podium.length === 0 ? (
            <p className="muted">Призёров пока нет: результаты не готовы.</p>
          ) : (
            <ol className="muted">
              {shown.podium.map((p) => (
                <li key={`${p.place}-${p.name}`} value={p.place}>
                  {p.name}
                  {p.detail && ` · ${p.detail}`} · {shown.points ? `${p.total} очк.` : p.total.toFixed(3)}
                </li>
              ))}
            </ol>
          )}
          <button type="button" disabled={busy} onClick={() => void send(null)}>
            Убрать с табло
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Общекомандный зачёт: очки клубам за места в многоборье, на снарядах и команд
 * по таблицам из положения. Ниже — текущая таблица клубов.
 */
export function ClubStandingPanel({ competitionId, adminToken, onError }: Omit<Props, "discipline">) {
  const [view, setView] = useState<ClubStandingView | null>(null);
  const clubSaved = useSaved();
  const [draft, setDraft] = useState({ allAround: "", apparatus: "", teams: "", best: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await apiRequest<ClubStandingView>(`/competitions/${competitionId}/results/clubs`);
      setView(next);
      const { allAround, apparatus, teams, best } = next.settings;
      const text = (list: number[]) => list.map((v) => String(v).replace(".", ",")).join(" ");
      setDraft({ allAround: text(allAround), apparatus: text(apparatus), teams: text(teams), best: best ? String(best) : "" });
    } catch (e) {
      onError((e as Error).message);
    }
  }, [competitionId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!view) return null;
  const parsed = {
    allAround: parsePoints(draft.allAround),
    apparatus: parsePoints(draft.apparatus),
    teams: parsePoints(draft.teams),
    best: draft.best.trim() ? Number(draft.best) : null,
  };
  const valid =
    parsed.allAround !== null &&
    parsed.apparatus !== null &&
    parsed.teams !== null &&
    (parsed.best === null || (Number.isInteger(parsed.best) && parsed.best >= 1 && parsed.best <= 50));

  const save = async () => {
    setBusy(true);
    try {
      await apiRequest(`/competitions/${competitionId}/club-standing`, { token: adminToken, method: "PUT", body: parsed });
      onError(null);
      await load();
      clubSaved.markSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = (key: "allAround" | "apparatus" | "teams", title: string) => (
    <label className="wide">
      {title}
      <input
        value={draft[key]}
        placeholder="например: 20 17 15 14 13 12 11 10 9 8 7 6 5 4 3 2 1"
        className={parsed[key] === null ? "invalid" : undefined}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
    </label>
  );

  return (
    <section className="panel no-print club-standing" {...clubSaved.watch}>
      <h2>Общекомандный зачёт</h2>
      <p className="muted wide">
        Очки клубу за 1-е, 2-е, 3-е… места его участников через пробел, как в положении; дальше списка — 0. Пустое поле —
        этот вид в зачёт не идёт. На снарядах считаются места в финале, если он был. Клуб участника берётся из заявки, а
        без клуба — его команда.
      </p>
      {field("allAround", "Очки за места в многоборье (в каждом разряде)")}
      {field("apparatus", "Очки за места на отдельных снарядах")}
      {field("teams", "Очки за места команд")}
      <label>
        Лучших результатов клуба в многоборье в разряде
        <input inputMode="numeric" placeholder="все" value={draft.best} onChange={(e) => setDraft({ ...draft, best: e.target.value.trim() })} />
      </label>
      <SaveButton saved={clubSaved.saved} disabled={busy || !valid} onClick={() => void save()}>
        Сохранить и пересчитать
      </SaveButton>
      {view.rows.length > 0 && (
        <table className="draw-table wide">
          <thead>
            <tr>
              <th>Место</th>
              <th>Клуб</th>
              <th>Многоборье</th>
              <th>Снаряды</th>
              <th>Команды</th>
              <th>1-2-3 места</th>
              <th>Очки</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <tr key={r.club}>
                <td>{r.rank}</td>
                <td>
                  <strong>{r.club}</strong>
                </td>
                <td>{r.allAround}</td>
                <td>{r.apparatus}</td>
                <td>{r.teams}</td>
                <td className="muted">{r.places.join(" / ")}</td>
                <td>
                  <strong>{r.total}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

type OfficialDraft = { name: string; category: string; city: string };

const officialDraft = (o: Official | null | undefined): OfficialDraft => ({
  name: o?.name ?? "",
  category: o?.category ?? "",
  city: o?.city ?? "",
});

const officialBody = (d: OfficialDraft): Official | null =>
  d.name.trim()
    ? {
        name: d.name.trim(),
        ...(d.category.trim() ? { category: d.category.trim() } : {}),
        ...(d.city.trim() ? { city: d.city.trim() } : {}),
      }
    : null;

/** Главный судья и главный секретарь: их ФИО и категории печатаются под протоколами. */
export function OfficialsPanel({
  competitionId,
  officials,
  adminToken,
  onError,
  onSaved,
}: Omit<Props, "discipline"> & {
  officials: { chiefJudge: Official | null; chiefSecretary: Official | null } | undefined;
  onSaved: () => void;
}) {
  const [judge, setJudge] = useState(officialDraft(officials?.chiefJudge));
  const [secretary, setSecretary] = useState(officialDraft(officials?.chiefSecretary));
  const officialsSaved = useSaved();
  const [busy, setBusy] = useState(false);
  const row = (title: string, d: OfficialDraft, set: (d: OfficialDraft) => void) => (
    <div className="wide normatives-row">
      <strong>{title}</strong>
      <input aria-label={`${title}: ФИО`} placeholder="Фамилия И. О." value={d.name} onChange={(e) => set({ ...d, name: e.target.value })} />
      <input
        aria-label={`${title}: категория`}
        placeholder="Категория"
        list="official-categories"
        className="narrow"
        value={d.category}
        onChange={(e) => set({ ...d, category: e.target.value })}
      />
      <input aria-label={`${title}: город`} placeholder="Город" value={d.city} onChange={(e) => set({ ...d, city: e.target.value })} />
    </div>
  );
  const save = async () => {
    setBusy(true);
    try {
      await apiRequest(`/competitions/${competitionId}/officials`, {
        token: adminToken,
        method: "PUT",
        body: { chiefJudge: officialBody(judge), chiefSecretary: officialBody(secretary) },
      });
      onError(null);
      officialsSaved.markSaved();
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel no-print officials" {...officialsSaved.watch}>
      <h2>Главная судейская коллегия</h2>
      <p className="muted wide">Печатается в подписях под протоколами и на грамотах.</p>
      {row("Главный судья", judge, setJudge)}
      {row("Главный секретарь", secretary, setSecretary)}
      <datalist id="official-categories">
        {JUDGE_CATEGORIES.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <SaveButton saved={officialsSaved.saved} disabled={busy} onClick={() => void save()}>
        Сохранить
      </SaveButton>
    </section>
  );
}

interface LevelDraft {
  name: string;
  min: string;
}

/**
 * Нормативы разрядов: в каждом разряде соревнований — уровни с минимальной суммой
 * многоборья. Протокол многоборья отмечает, кто какой разряд выполнил.
 */
export function NormativesPanel({ competitionId, adminToken, onError }: Omit<Props, "discipline">) {
  const [view, setView] = useState<NormativesView | null>(null);
  const normativesSaved = useSaved();
  const [drafts, setDrafts] = useState<Record<string, LevelDraft[]>>({});
  const [busy, setBusy] = useState(false);

  const apply = (next: NormativesView) => {
    setView(next);
    setDrafts(
      Object.fromEntries(
        next.categories.map((c) => [c.id, c.levels.map((l) => ({ name: l.name, min: l.min.toFixed(3) }))]),
      ),
    );
  };

  useEffect(() => {
    apiRequest<NormativesView>(`/competitions/${competitionId}/normatives`)
      .then(apply)
      .catch((e: Error) => onError(e.message));
  }, [competitionId, onError]);

  if (!view || view.categories.length === 0) return null;

  // Сумма многоборья: до трёх знаков после точки, запятая тоже подойдёт.
  const parse = (l: LevelDraft) => {
    const text = l.min.trim().replace(",", ".");
    return { name: l.name.trim(), min: /^\d{1,3}(\.\d{1,3})?$/.test(text) ? Number(text) : null };
  };
  const invalid = Object.values(drafts)
    .flat()
    .some((l) => {
      const p = parse(l);
      return !p.name || p.min === null || p.min <= 0 || p.min > 200;
    });
  const setLevels = (id: string, levels: LevelDraft[]) => setDrafts((all) => ({ ...all, [id]: levels }));

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        categories: view.categories.map((c) => ({
          categoryId: c.id,
          levels: (drafts[c.id] ?? []).map((l) => {
            const p = parse(l);
            return { name: p.name, min: p.min! };
          }),
        })),
      };
      apply(await apiRequest<NormativesView>(`/competitions/${competitionId}/normatives`, { token: adminToken, method: "PUT", body }));
      onError(null);
      normativesSaved.markSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel no-print normatives" {...normativesSaved.watch}>
      <h2>Нормативы разрядов</h2>
      <p className="muted wide">
        Минимальная сумма многоборья для выполнения разряда. Разряд выполняет тот, кто выступил на всех снарядах и
        набрал не меньше норматива; если уровней несколько, засчитывается высший. Нормативы можно поправить в любой
        момент, протоколы пересчитаются.
      </p>
      {view.categories.map((c) => {
        const levels = drafts[c.id] ?? [];
        return (
          <div key={c.id} className="wide normatives-row">
            <strong>{c.name}</strong>
            {levels.map((l, i) => (
              <span key={i} className="normatives-level">
                <input
                  aria-label={`Разряд ${c.name}: название уровня`}
                  placeholder="Разряд"
                  value={l.name}
                  onChange={(e) => setLevels(c.id, levels.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                <span className="muted">от</span>
                <input
                  aria-label={`Разряд ${c.name}: сумма`}
                  inputMode="decimal"
                  placeholder="48.000"
                  className="narrow"
                  value={l.min}
                  onChange={(e) => setLevels(c.id, levels.map((x, j) => (j === i ? { ...x, min: e.target.value } : x)))}
                />
                <button type="button" className="link danger" onClick={() => setLevels(c.id, levels.filter((_, j) => j !== i))}>
                  убрать
                </button>
              </span>
            ))}
            {levels.length < 6 && (
              <button
                type="button"
                className="link"
                onClick={() => setLevels(c.id, [...levels, { name: levels.length === 0 ? c.name : "", min: "" }])}
              >
                + уровень
              </button>
            )}
          </div>
        );
      })}
      <SaveButton saved={normativesSaved.saved} disabled={busy || invalid} onClick={() => void save()}>
        Сохранить нормативы
      </SaveButton>
    </section>
  );
}

interface GymnastDraft {
  bib: string;
  lastName: string;
  firstName: string;
  middleName: string;
  birthDate: string;
  club: string;
  city: string;
  coach: string;
  team: string;
  category: string;
  shift: string;
}

/** Строка участника: статус меняется сразу, остальное — по кнопке «Изменить». */
function GymnastRow({
  gymnast: g,
  team,
  category,
  save,
  remove,
  onError,
}: {
  gymnast: RosterGymnast;
  team: string;
  category: string;
  save: (patch: object) => Promise<void>;
  remove: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [draft, setDraft] = useState<GymnastDraft | null>(null);
  const run = async (action: () => Promise<void>) => {
    try {
      await action();
      onError(null);
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    }
  };
  const statusSelect = (
    <select
      value={g.status}
      className={g.status === "ACTIVE" ? undefined : "out"}
      onChange={(e) => void run(() => save({ status: e.target.value }))}
    >
      {GYMNAST_STATUSES.map((s) => (
        <option key={s} value={s}>
          {GYMNAST_STATUS_NAMES[s]}
        </option>
      ))}
    </select>
  );

  if (!draft) {
    return (
      <tr className={g.status === "ACTIVE" ? undefined : "out"}>
        <td>№{g.bib}</td>
        <td>
          {g.lastName} {g.firstName} {g.middleName ?? ""}
          {(g.birthDate || g.coach) && (
            <div className="muted small">
              {[g.birthDate && `д.р. ${g.birthDate}`, g.coach && `тренер ${g.coach}`].filter(Boolean).join(" · ")}
            </div>
          )}
        </td>
        <td className="muted">{[g.club, g.city].filter(Boolean).join(", ")}</td>
        <td className="muted">{team}</td>
        <td className="muted">{category}</td>
        <td className="muted">{g.shift ? `смена ${g.shift}` : ""}</td>
        <td>{statusSelect}</td>
        <td>
          <button
            type="button"
            className="link"
            onClick={() =>
              setDraft({
                bib: String(g.bib),
                lastName: g.lastName,
                firstName: g.firstName,
                middleName: g.middleName ?? "",
                birthDate: g.birthDate ?? "",
                club: g.club ?? "",
                city: g.city ?? "",
                coach: g.coach ?? "",
                team,
                category,
                shift: g.shift ? String(g.shift) : "",
              })
            }
          >
            Изменить
          </button>
        </td>
      </tr>
    );
  }

  const field = (key: keyof GymnastDraft, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} {...props} />
  );
  const bib = Number(draft.bib);
  const shift = draft.shift.trim() ? Number(draft.shift) : null;
  const birthOk = draft.birthDate.trim() === "" || /^(\d{4}|\d{2}\.\d{2}\.\d{4})$/.test(draft.birthDate.trim());
  const valid =
    birthOk &&
    Number.isInteger(bib) &&
    bib >= 1 &&
    draft.lastName.trim() !== "" &&
    draft.firstName.trim() !== "" &&
    (shift === null || (Number.isInteger(shift) && shift >= 1 && shift <= 50));
  return (
    <tr className="editing">
      <td>{field("bib", { inputMode: "numeric", "aria-label": "Номер", className: "narrow" })}</td>
      <td>
        {field("lastName", { "aria-label": "Фамилия", placeholder: "Фамилия" })}
        {field("firstName", { "aria-label": "Имя", placeholder: "Имя" })}
        {field("middleName", { "aria-label": "Отчество", placeholder: "Отчество" })}
        {field("birthDate", {
          "aria-label": "Дата рождения",
          placeholder: "Дата рождения: 2014 или 15.03.2014",
          className: birthOk ? undefined : "invalid",
        })}
      </td>
      <td>
        {field("club", { "aria-label": "Клуб", placeholder: "Клуб" })}
        {field("city", { "aria-label": "Город", placeholder: "Город" })}
        {field("coach", { "aria-label": "Тренер", placeholder: "Тренер" })}
      </td>
      <td>{field("team", { "aria-label": "Команда", placeholder: "Команда", list: "team-names" })}</td>
      <td>{field("category", { "aria-label": "Разряд", placeholder: "Разряд", list: "category-names" })}</td>
      <td>{field("shift", { "aria-label": "Смена", placeholder: "Смена", inputMode: "numeric", className: "narrow" })}</td>
      <td>{statusSelect}</td>
      <td className="actions">
        <button
          type="button"
          className="primary"
          disabled={!valid}
          onClick={() =>
            void run(() =>
              save({
                bib,
                lastName: draft.lastName.trim(),
                firstName: draft.firstName.trim(),
                middleName: draft.middleName.trim() || null,
                birthDate: draft.birthDate.trim() || null,
                club: draft.club.trim() || null,
                city: draft.city.trim() || null,
                coach: draft.coach.trim() || null,
                team: draft.team.trim() || null,
                category: draft.category.trim() || null,
                shift,
              }),
            ).then((ok) => ok && setDraft(null))
          }
        >
          Сохранить
        </button>
        <button type="button" onClick={() => setDraft(null)}>
          Отмена
        </button>
        <button
          type="button"
          className="link danger"
          onClick={() => {
            if (confirm(`Удалить ${g.lastName} ${g.firstName} из списка?`)) void run(remove);
          }}
        >
          Удалить
        </button>
      </td>
    </tr>
  );
}

type SeriesDraft = { id: string | null; name: string; points: string; best: string; stages: string[] };

const emptySeries: SeriesDraft = { id: null, name: "", points: "", best: "", stages: [] };

/**
 * Кубок из нескольких этапов: каждое соревнование — этап, участникам идут очки
 * за места в многоборье, итог — сумма по этапам (или по лучшим из них).
 */
export function SeriesPanel({
  competitions,
  adminToken,
  onError,
}: {
  competitions: { id: string; name: string }[];
  adminToken: string;
  onError: (message: string | null) => void;
}) {
  const [list, setList] = useState<SeriesView[]>([]);
  const [draft, setDraft] = useState<SeriesDraft | null>(null);
  const [standings, setStandings] = useState<SeriesStandings | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await apiRequest<SeriesView[]>("/series"));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const show = async (id: string) => {
    try {
      setStandings(await apiRequest<SeriesStandings>(`/series/${id}/standings`));
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const edit = (s: SeriesView) =>
    setDraft({
      id: s.id,
      name: s.name,
      points: s.points.map((v) => String(v).replace(".", ",")).join(" "),
      best: s.best ? String(s.best) : "",
      stages: s.stages,
    });

  const points = draft ? parsePoints(draft.points) : null;
  const best = draft?.best.trim() ? Number(draft.best) : null;
  const valid =
    draft !== null &&
    draft.name.trim() !== "" &&
    points !== null &&
    points.length > 0 &&
    (best === null || (Number.isInteger(best) && best >= 1 && best <= 50));

  const save = async () => {
    if (!draft || !valid) return;
    setBusy(true);
    try {
      const body = { name: draft.name.trim(), points, best, stages: draft.stages };
      const saved = await apiRequest<SeriesView>(draft.id ? `/series/${draft.id}` : "/series", {
        token: adminToken,
        method: draft.id ? "PUT" : "POST",
        body,
      });
      setDraft(null);
      onError(null);
      await load();
      await show(saved.id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: SeriesView) => {
    if (!window.confirm(`Удалить кубок «${s.name}»? Результаты этапов останутся.`)) return;
    try {
      await apiRequest(`/series/${s.id}`, { token: adminToken, method: "DELETE" });
      if (standings?.series.id === s.id) setStandings(null);
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const pdf = async (id: string) => {
    const tab = window.open("", "_blank");
    try {
      const response = await fetch(`/series/${id}/protocol`, { headers: { Authorization: `Bearer ${adminToken}` } });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new ApiError(response.status, data?.message ?? `Ошибка сервера ${response.status}`);
      }
      const url = URL.createObjectURL(await response.blob());
      if (tab) tab.location.href = url;
      onError(null);
    } catch (e) {
      tab?.close();
      onError((e as Error).message);
    }
  };

  const toggleStage = (id: string) => {
    if (!draft) return;
    const stages = draft.stages.includes(id) ? draft.stages.filter((s) => s !== id) : [...draft.stages, id];
    setDraft({ ...draft, stages });
  };

  return (
    <section className="panel no-print series">
      <h2>Кубок из нескольких этапов</h2>
      <p className="muted wide">
        Каждое соревнование — этап кубка. На этапе участник получает очки за место в многоборье своего разряда, итог —
        сумма очков. Участники разных этапов сопоставляются по фамилии, имени и году рождения, разряды — по названию.
      </p>
      {list.length > 0 && (
        <table className="draw-table wide">
          <tbody>
            {list.map((s) => (
              <tr key={s.id}>
                <td>
                  <strong>{s.name}</strong>
                  <div className="muted">
                    Этапов: {s.stages.length}
                    {s.best ? ` · в зачёт ${s.best} лучших` : ""}
                  </div>
                </td>
                <td>
                  <button type="button" onClick={() => void show(s.id)}>
                    Итоги
                  </button>{" "}
                  <button type="button" onClick={() => void pdf(s.id)}>
                    Протокол PDF
                  </button>{" "}
                  <button type="button" className="link" onClick={() => edit(s)}>
                    Изменить
                  </button>{" "}
                  <button type="button" className="link" onClick={() => void remove(s)}>
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {draft ? (
        <>
          <label className="wide">
            Название кубка
            <input value={draft.name} placeholder="Кубок области 2026" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="wide">
            Очки за места на этапе
            <input
              value={draft.points}
              placeholder="например: 25 20 16 13 11 10 9 8 7 6 5 4 3 2 1"
              className={points === null || points.length === 0 ? "invalid" : undefined}
              onChange={(e) => setDraft({ ...draft, points: e.target.value })}
            />
          </label>
          <label>
            Лучших этапов в зачёт
            <input inputMode="numeric" placeholder="все" value={draft.best} onChange={(e) => setDraft({ ...draft, best: e.target.value.trim() })} />
          </label>
          <fieldset className="wide series-stages">
            <legend>Этапы (по порядку проведения — в порядке отметки)</legend>
            {competitions.map((c) => {
              const index = draft.stages.indexOf(c.id);
              return (
                <label key={c.id} className="check">
                  <input type="checkbox" checked={index >= 0} onChange={() => toggleStage(c.id)} />
                  {index >= 0 && <strong>{index + 1}. </strong>}
                  {c.name}
                </label>
              );
            })}
          </fieldset>
          <div className="wide">
            <button type="button" className="primary" disabled={busy || !valid} onClick={() => void save()}>
              {draft.id ? "Сохранить кубок" : "Создать кубок"}
            </button>{" "}
            <button type="button" onClick={() => setDraft(null)}>
              Отмена
            </button>
          </div>
        </>
      ) : (
        <button type="button" onClick={() => setDraft(emptySeries)}>
          Новый кубок
        </button>
      )}

      {standings && (
        <div className="wide series-standings">
          <h3>{standings.series.name}</h3>
          {standings.categories.length === 0 && <p className="muted">Пока нет законченного многоборья ни на одном этапе.</p>}
          {standings.categories.map((cat) => (
            <div key={cat.name}>
              <h4>{cat.name}</h4>
              <table className="draw-table">
                <thead>
                  <tr>
                    <th>Место</th>
                    <th>Участник</th>
                    {standings.stages.map((s, i) => (
                      <th key={s.id} title={s.name}>
                        Этап {i + 1}
                      </th>
                    ))}
                    <th>Очки</th>
                  </tr>
                </thead>
                <tbody>
                  {cat.rows.map((r) => (
                    <tr key={`${r.name}|${r.birthYear}`}>
                      <td>{r.rank}</td>
                      <td>
                        <strong>{r.name}</strong>
                        <div className="muted">{[r.birthYear, r.club].filter(Boolean).join(" · ")}</div>
                      </td>
                      {r.stages.map((p, i) => (
                        <td key={i} className={r.dropped.includes(i) ? "muted" : undefined}>
                          {p === null ? "—" : r.dropped.includes(i) ? `(${p})` : p}
                        </td>
                      ))}
                      <td>
                        <strong>{r.total}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <p className="muted">Этапы: {standings.stages.map((s, i) => `${i + 1}. ${s.name}`).join("; ")}</p>
        </div>
      )}
      {draft === null && list.length === 0 && competitions.length < 2 && (
        <p className="muted wide">Заведите соревнования для каждого этапа — затем соберите их в кубок.</p>
      )}
    </section>
  );
}

/** Загрузка турнира из файла, выгруженного на другом компьютере. */
export function ImportCompetitionForm({
  adminToken,
  onImported,
  onError,
}: {
  adminToken: string;
  onImported: (id: string) => void;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const upload = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setBusy(true);
    setDone(null);
    try {
      let body: unknown;
      try {
        body = JSON.parse(await file.text());
      } catch {
        throw new Error("Файл повреждён или это не файл турнира");
      }
      const imported = await apiRequest<{ id: string; name: string }>("/competitions/import", {
        token: adminToken,
        method: "POST",
        body,
      });
      setDone(
        `Турнир «${imported.name}» загружен. Прежние QR-коды судей действуют, только если у этого компьютера тот же адрес в сети, что был у прежнего. Иначе выдайте судьям новые QR-коды.`,
      );
      onError(null);
      onImported(imported.id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel no-print">
      <p className="muted wide">
        Выберите файл, выгруженный кнопкой «Выгрузить в файл» на другом компьютере. Загрузятся участники, судьи, оценки,
        финалы, запросы и журнал изменений.
      </p>
      <label className="wide">
        Файл турнира (.json)
        <input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => void upload(e.currentTarget)} />
      </label>
      {busy && <p className="muted wide">Загрузка…</p>}
      {done && <p className="wide">{done}</p>}
    </section>
  );
}

/** Перенос турнира на другой компьютер файлом и удаление турнира со всеми данными. */
export function TransferPanel({
  competitionId,
  name,
  adminToken,
  onError,
  onDeleted,
}: {
  competitionId: string;
  name: string;
  adminToken: string;
  onError: (message: string | null) => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmName, setConfirmName] = useState("");

  const download = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/competitions/${competitionId}/export`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new ApiError(response.status, data?.message ?? `Ошибка сервера ${response.status}`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `${name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "турнир"} ${new Date().toLocaleDateString("ru-RU")}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Удалить турнир «${name}» со всеми участниками, судьями, оценками и журналом? Отменить это нельзя.`)) return;
    setBusy(true);
    try {
      await apiRequest(`/competitions/${competitionId}`, { token: adminToken, method: "DELETE" });
      setConfirmName("");
      onError(null);
      onDeleted();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel no-print">
      <h2>Перенос и удаление турнира</h2>
      <p className="muted wide">
        Файл турнира содержит всё: участников, судей, оценки, финалы, запросы и журнал. На другом компьютере загрузите его в
        разделе «Загрузить турнир из файла». Прежние QR-коды судей подойдут, если у нового компьютера тот же адрес в сети.
      </p>
      <div className="wide">
        <button type="button" className="primary" disabled={busy} onClick={() => void download()}>
          Выгрузить в файл
        </button>
      </div>
      <label className="wide">
        Чтобы удалить турнир, введите его название: {name}
        <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
      </label>
      <div className="wide">
        <button
          type="button"
          className="primary danger"
          disabled={busy || confirmName.trim() !== name.trim()}
          onClick={() => void remove()}
        >
          Удалить турнир
        </button>
        <p className="muted">Перед удалением выгрузите турнир в файл, если он ещё понадобится.</p>
      </div>
    </section>
  );
}

type ProgressView = "AA" | Apparatus;

/**
 * Ход соревнования для секретаря: кто сейчас на снарядах и таблицы по разрядам —
 * все участники разряда, а не только выступившие, с оценками по снарядам и местами.
 * Пока экран открыт, данные обновляются каждые 5 секунд.
 */
interface PanelSeat {
  id: string;
  apparatus: Apparatus;
  role: "D" | "E" | "SUPERVISOR";
  seat: number;
}

interface ManualDraft {
  gymnastId: string;
  d: string;
  e: string[];
  neutral: string;
}

// Быстрый ввод, как на планшете судьи: «95» — это 9.50, «9» — 9.00.
const parseField = (text: string, kind: "D" | "E") => parseScore(expandScore(text), kind);

/** Черновик формы по уже утверждённой оценке или пустой. */
function draftFor(gymnastId: string, eCount: number, perf: PerformanceView | undefined): ManualDraft {
  const marks = perf?.status === "APPROVED" ? perf.marks : [];
  const e = marks.filter((m) => m.kind === "E").map((m) => fmt(m.value));
  const d = marks.find((m) => m.kind === "D");
  const neutral = marks.find((m) => m.kind === "NEUTRAL");
  return {
    gymnastId,
    d: d ? fmt(d.value) : "",
    e: Array.from({ length: eCount }, (_, i) => e[i] ?? ""),
    neutral: neutral ? fmt(neutral.value) : "",
  };
}

/**
 * Ввод оценок с судейских листов. Если планшеты потеряли связь, судьи пишут
 * оценки на бумаге, а секретарь вводит их здесь: оценка сразу утверждается.
 * Здесь же исправляют и удаляют любую оценку; всё попадает в журнал.
 */
export function ManualScoresPanel({
  competitionId,
  discipline,
  adminToken,
  onError,
  rules,
  active = true,
}: Props & { active?: boolean }) {
  const program = apparatusFor(discipline);
  const labels = scoreLabels(rules ?? "FIG");
  const custom = rules === "CUSTOM";
  const [apparatus, setApparatus] = useState<Apparatus>(program[0]!);
  const [attempt, setAttempt] = useState(1);
  const [shift, setShift] = useState("all");
  const [category, setCategory] = useState("all");
  // Свёрнутые разряды. По умолчанию всё раскрыто: секретарь сразу видит участников и кнопки «Ввести».
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [people, setPeople] = useState<DrawGymnast[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [seats, setSeats] = useState<PanelSeat[]>([]);
  const [perfs, setPerfs] = useState<PerformanceView[]>([]);
  const [phase, setPhase] = useState<"QUAL" | "FINAL">("QUAL");
  const [draft, setDraft] = useState<ManualDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const form = useRef<HTMLTableRowElement>(null);

  const load = useCallback(async () => {
    try {
      const [list, cats, judges, done, competition] = await Promise.all([
        apiRequest<DrawGymnast[]>(`/competitions/${competitionId}/gymnasts`),
        apiRequest<{ id: string; name: string }[]>(`/competitions/${competitionId}/categories`),
        apiRequest<PanelSeat[]>(`/competitions/${competitionId}/judges`, { token: adminToken }),
        apiRequest<PerformanceView[]>(`/competitions/${competitionId}/performances?apparatus=${apparatus}`, { token: adminToken }),
        apiRequest<{ phase: "QUAL" | "FINAL" }>(`/competitions/${competitionId}`),
      ]);
      setPeople(list);
      setCategories(cats);
      setSeats(judges);
      setPerfs(done);
      setPhase(competition.phase);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [competitionId, adminToken, apparatus, onError]);

  // Судей и участников заводят на других вкладках: при возврате сюда перечитываем, иначе блок помнит старую бригаду.
  useEffect(() => {
    if (active) void load();
  }, [load, active]);
  // Оценки с планшетов приходят сразу, без перезагрузки страницы.
  const reload = useCallback(() => void load(), [load]);
  useCompetitionLive(competitionId, active, reload);

  useEffect(() => {
    form.current?.querySelector("input")?.focus();
  }, [draft?.gymnastId]);

  const eCount = seats.filter((j) => j.apparatus === apparatus && j.role === "E").length;
  const hasD = seats.some((j) => j.apparatus === apparatus && (j.role === "D" || j.role === "SUPERVISOR"));
  const shifts = [...new Set(people.map((g) => g.shift).filter((n): n is number => n !== null))].sort((a, b) => a - b);
  const byGymnast = new Map(
    perfs.filter((p) => p.stage === phase && p.attempt === attempt).map((p) => [p.gymnastId, p] as const),
  );
  const query = search.trim().toLowerCase();
  // Разряды — отдельными блоками в порядке, как они заведены; внутри разряда — по сменам и порядку выхода.
  const byCategory = categories.length > 1;
  const categoryRank = new Map(categories.map((c, i) => [c.id, i] as const));
  const categoryName = new Map(categories.map((c) => [c.id, c.name] as const));
  const rankOf = (g: RosterGymnast) => (g.categoryId ? categoryRank.get(g.categoryId) ?? 999 : 999);
  const rows = people
    .filter((g) => shift === "all" || String(g.shift) === shift)
    .filter((g) => category === "all" || (g.categoryId ?? "none") === category)
    .filter((g) => !query || String(g.bib) === query || g.lastName.toLowerCase().startsWith(query))
    .sort(
      (a, b) =>
        (byCategory ? rankOf(a) - rankOf(b) : 0) ||
        (a.shift ?? 99) - (b.shift ?? 99) ||
        (a.startOrder ?? Number.MAX_SAFE_INTEGER) - (b.startOrder ?? Number.MAX_SAFE_INTEGER) ||
        a.bib - b.bib,
    );

  const toggleGroup = (group: string) =>
    setClosedGroups((set) => {
      const next = new Set(set);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });

  const open = (g: RosterGymnast) => {
    setSaved(null);
    setDraft(draftFor(g.id, eCount, byGymnast.get(g.id)));
  };

  const d = draft ? (draft.d.trim() === "" && custom ? 0 : parseField(draft.d, "D")) : null;
  const e = draft ? draft.e.map((v) => parseField(v, "E")) : [];
  const neutral = draft ? (draft.neutral.trim() === "" ? 0 : parseField(draft.neutral, "E")) : null;
  const valid = draft !== null && d !== null && neutral !== null && e.every((v) => v !== null);
  const preview =
    valid && !custom ? scorePerformance({ d: toPoints(d), eDeductions: e.map((v) => toPoints(v!)), neutral: toPoints(neutral) }) : null;

  const save = async () => {
    if (!draft || !valid) return;
    setBusy(true);
    try {
      const g = people.find((p) => p.id === draft.gymnastId)!;
      const view = await apiRequest<PerformanceView>(`/competitions/${competitionId}/manual-scores`, {
        token: adminToken,
        method: "POST",
        body: { gymnastId: draft.gymnastId, apparatus, attempt, d, e, ...(neutral ? { neutral } : {}) },
      });
      onError(null);
      setSaved(`№${g.bib} ${g.lastName}: ${view.score ? fmt(view.score.total) : "—"}`);
      await load();
      // Следующий по списку без оценки — чтобы вводить лист подряд.
      const next = rows.slice(rows.indexOf(g) + 1).find((p) => p.status === "ACTIVE" && !byGymnast.has(p.id));
      if (next)
        setClosedGroups((set) => {
          const open = new Set(set);
          open.delete(next.categoryId ?? "none");
          return open;
        });
      setDraft(next ? draftFor(next.id, eCount, undefined) : null);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (g: RosterGymnast, perf: PerformanceView) => {
    const total = perf.score ? ` (${fmt(perf.score.total)})` : "";
    if (!confirm(`Удалить оценку №${g.bib} ${g.lastName} ${g.firstName} на снаряде «${APPARATUS_NAMES[apparatus]}»${total}? Она пропадёт из результатов и протоколов.`)) return;
    setBusy(true);
    try {
      await apiRequest(`/performances/${perf.id}`, { token: adminToken, method: "DELETE" });
      onError(null);
      setDraft(null);
      setSaved(`Оценка №${g.bib} ${g.lastName} удалена`);
      await load();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Enter в поле переходит к следующему, в последнем — сохраняет.
  const onKey = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Escape") setDraft(null);
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    const inputs = [...(form.current?.querySelectorAll("input") ?? [])];
    const i = inputs.indexOf(ev.currentTarget);
    if (i < inputs.length - 1) inputs[i + 1]!.focus();
    else void save();
  };
  const input = (value: string, onChange: (v: string) => void, title: string, bad: boolean) => (
    <label className="manual-field">
      {title}
      <input
        inputMode="decimal"
        value={value}
        className={bad ? "invalid" : undefined}
        onChange={(ev) => onChange(ev.target.value)}
        onBlur={() => value.trim() && onChange(expandScore(value))}
        onKeyDown={onKey}
      />
    </label>
  );

  const columns = 6;
  return (
    <section className="panel no-print manual-scores">
      <h2>Ввод оценок с судейских листов</h2>
      <p className="muted wide">
        Если планшеты потеряли связь, судьи записывают оценки на листы, а секретарь вводит их здесь. Оценка сразу утверждается и
        идёт в результаты, на табло и в протоколы. Здесь же можно исправить или удалить любую оценку, всё записывается в журнал.
      </p>
      <div className="wide progress-views">
        {program.map((a) => (
          <button
            key={a}
            type="button"
            className={apparatus === a ? "active" : undefined}
            onClick={() => {
              setApparatus(a);
              setAttempt(1);
              setDraft(null);
              setSaved(null);
            }}
          >
            <ApparatusIcon code={a} /> {APPARATUS_NAMES[a]}
          </button>
        ))}
      </div>
      <label>
        Смена
        <select value={shift} onChange={(ev) => setShift(ev.target.value)}>
          <option value="all">Все смены</option>
          {shifts.map((n) => (
            <option key={n} value={String(n)}>
              Смена {n}
            </option>
          ))}
        </select>
      </label>
      {byCategory && (
        <label>
          Разряд
          <select value={category} onChange={(ev) => (setCategory(ev.target.value), setDraft(null))}>
            <option value="all">Все разряды</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {people.some((g) => !g.categoryId) && <option value="none">Без разряда</option>}
          </select>
        </label>
      )}
      <label>
        Найти
        <input value={search} placeholder="номер или фамилия" onChange={(ev) => setSearch(ev.target.value)} />
      </label>
      {apparatus === "VT" && (
        <label>
          Прыжок
          <select value={attempt} onChange={(ev) => (setAttempt(Number(ev.target.value)), setDraft(null))}>
            <option value={1}>Первый</option>
            <option value={2}>Второй</option>
          </select>
        </label>
      )}
      {(eCount === 0 || (!hasD && !custom)) && (
        <p className="warning wide">
          На снаряде «{APPARATUS_NAMES[apparatus]}» не заведены судьи {eCount === 0 ? "E" : "D"}. Заведите бригаду на вкладке
          «Судьи»: оценки записываются за судьями и попадают в протокол.
        </p>
      )}
      {saved && <p className="wide manual-saved">{saved.startsWith("Оценка") ? saved : `Сохранено: ${saved}`}</p>}
      <div className="wide table-scroll">
        <table className="draw-table manual-table">
          <thead>
            <tr>
              <th>№</th>
              <th>Участник</th>
              <th>Смена</th>
              <th className="num">{labels.d}</th>
              <th className="num">Итог</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((g, i) => {
              const perf = byGymnast.get(g.id);
              const newGroup = byCategory && (i === 0 || rows[i - 1]!.categoryId !== g.categoryId);
              const approved = perf?.status === "APPROVED" && perf.score;
              const editing = draft?.gymnastId === g.id;
              const out = g.status !== "ACTIVE";
              const group = g.categoryId ?? "none";
              // При поиске и при выбранном разряде список показывается целиком.
              const folded = byCategory && category === "all" && !query && closedGroups.has(group);
              const inGroup = newGroup ? rows.filter((r) => (r.categoryId ?? "none") === group) : [];
              const entered = inGroup.filter((r) => byGymnast.get(r.id)?.status === "APPROVED").length;
              return (
                <Fragment key={g.id}>
                  {newGroup && (
                    <tr className={folded ? "manual-group" : "manual-group open"}>
                      <th colSpan={columns}>
                        <button type="button" onClick={() => toggleGroup(group)}>
                          {(g.categoryId && categoryName.get(g.categoryId)) || "Без разряда"}
                          <span className="muted">
                            {" "}
                            · введено {entered} из {inGroup.length}
                          </span>
                        </button>
                      </th>
                    </tr>
                  )}
                  {!folded && (
                    <tr className={editing ? "now" : out ? "out" : undefined}>
                      <td>{g.bib}</td>
                      <td>
                        {g.lastName} {g.firstName}
                      </td>
                      <td>{g.shift ?? ""}</td>
                      <td className="num">{approved ? fmt(perf.score!.d) : ""}</td>
                      <td className="num">
                        {out ? (
                          GYMNAST_STATUS_NAMES[g.status]
                        ) : approved ? (
                          <strong>{fmt(perf.score!.total)}</strong>
                        ) : perf ? (
                          <span className="muted">идёт оценка</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="manual-actions">
                        {!out && !editing && (
                          <button type="button" disabled={busy || eCount === 0} onClick={() => open(g)}>
                            {approved ? "Исправить" : "Ввести"}
                          </button>
                        )}
                        {perf && !editing && (
                          <button type="button" className="danger" disabled={busy} onClick={() => void remove(g, perf)}>
                            Удалить
                          </button>
                        )}
                      </td>
                    </tr>
                  )}
                  {!folded && editing && draft && (
                    <tr ref={form} className="manual-form">
                      <td colSpan={columns}>
                        <div className="manual-fields">
                          {input(draft.d, (v) => setDraft({ ...draft, d: v }), custom ? `${labels.d}` : "D", d === null)}
                          {draft.e.map((v, i) =>
                            input(
                              v,
                              (next) => setDraft({ ...draft, e: draft.e.map((x, k) => (k === i ? next : x)) }),
                              `E${i + 1}`,
                              v !== "" && e[i] === null,
                            ),
                          )}
                          {input(draft.neutral, (v) => setDraft({ ...draft, neutral: v }), "НС", neutral === null)}
                          <div className="manual-total">
                            {preview ? (
                              <>
                                Итог <strong>{fmt(fromPoints(preview.total))}</strong>
                                <span className="muted"> · E {fmt(fromPoints(preview.e))}</span>
                              </>
                            ) : custom && valid ? (
                              <span className="muted">Итог посчитает программа по базе разряда</span>
                            ) : (
                              <span className="muted">Введите все оценки</span>
                            )}
                          </div>
                        </div>
                        <div className="manual-buttons">
                          <button type="button" className="primary" disabled={!valid || busy} onClick={() => void save()}>
                            Сохранить и утвердить
                          </button>
                          <button type="button" onClick={() => setDraft(null)}>
                            Отмена
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns} className="muted">
                  Нет участников
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted wide">
        Можно набирать без точки: «9» — это 9.00, «95» — 9.50, «125» — 1.25. Enter переходит к следующему полю, в последнем поле сохраняет. После сохранения открывается следующий участник без оценки.
      </p>
    </section>
  );
}

export function ProgressPanel({
  competitionId,
  discipline,
  active,
  onError,
}: {
  competitionId: string;
  discipline: Discipline;
  active: boolean;
  onError: (message: string | null) => void;
}) {
  const [snap, setSnap] = useState<BoardSnapshot | null>(null);
  const [people, setPeople] = useState<RosterGymnast[]>([]);
  const [category, setCategory] = useState("all");
  const [shift, setShift] = useState("all");
  const [view, setView] = useState<ProgressView>("AA");
  const [updated, setUpdated] = useState<Date | null>(null);
  // Развёрнутые разряды. Таблица обновляется каждые 5 секунд, выбор при этом сохраняется.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const program = apparatusFor(discipline);

  const load = useCallback(async () => {
    try {
      const [next, list] = await Promise.all([
        apiRequest<BoardSnapshot>(`/competitions/${competitionId}/results/snapshot`),
        apiRequest<RosterGymnast[]>(`/competitions/${competitionId}/gymnasts`),
      ]);
      setSnap(next);
      setPeople(list);
      setUpdated(new Date());
    } catch (e) {
      onError((e as Error).message);
    }
  }, [competitionId, onError]);

  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [active, load]);

  if (!snap) return null;
  const labels = scoreLabels(snap.competition.rules);
  const shifts = [...new Set(people.map((g) => g.shift).filter((n): n is number => n !== null))].sort((a, b) => a - b);
  const onApparatus = new Map(
    snap.live.flatMap((l) => (l.current ? [[l.current.gymnast.id, l.apparatus] as const] : [])),
  );
  const categories = snap.categories.filter((c) => category === "all" || (c.id ?? "none") === category);
  // Один разряд на экране — он раскрыт всегда, сворачивать нечего.
  const single = categories.length === 1;
  const isOpen = (key: string) => single || expanded.has(key);
  const toggle = (key: string, open: boolean) =>
    setExpanded((prev) => {
      if (prev.has(key) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <section className="panel no-print progress">
      <h2>Ход соревнования</h2>
      <div className="wide progress-live">
        {snap.live
          .filter((l) => program.includes(l.apparatus))
          .map((l) => (
            <div key={l.apparatus} className="progress-card">
              <div className="progress-card-title">{APPARATUS_NAMES[l.apparatus]}</div>
              <div>
                <span className="muted">Выступает: </span>
                {l.current ? `№${l.current.gymnast.bib} ${l.current.gymnast.lastName} ${l.current.gymnast.firstName}` : "—"}
              </div>
              <div>
                <span className="muted">Последняя оценка: </span>
                {l.last ? (
                  <>
                    №{l.last.gymnast.bib} {l.last.gymnast.lastName} — <strong>{fmt(l.last.score.total)}</strong>
                  </>
                ) : (
                  "—"
                )}
              </div>
            </div>
          ))}
      </div>
      <label>
        Разряд
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="all">Все разряды</option>
          {snap.categories.map((c) => (
            <option key={c.id ?? "none"} value={c.id ?? "none"}>
              {c.name || "Без разряда"}
            </option>
          ))}
        </select>
      </label>
      <label>
        Смена
        <select value={shift} onChange={(e) => setShift(e.target.value)}>
          <option value="all">Все смены</option>
          {shifts.map((n) => (
            <option key={n} value={String(n)}>
              Смена {n}
            </option>
          ))}
        </select>
      </label>
      <div className="wide progress-views">
        {(["AA", ...program] as ProgressView[]).map((v) => (
          <button key={v} type="button" className={view === v ? "active" : undefined} onClick={() => setView(v)}>
            {v === "AA" ? "Многоборье" : APPARATUS_NAMES[v]}
          </button>
        ))}
      </div>
      {updated && <p className="muted wide">Обновлено в {updated.toLocaleTimeString("ru-RU")}, обновляется само каждые 5 секунд.</p>}
      {!single && categories.length > 0 && (
        <div className="wide progress-views">
          <button type="button" onClick={() => setExpanded(new Set(categories.map((c) => c.id ?? "none")))}>
            Развернуть все
          </button>
          <button type="button" onClick={() => setExpanded(new Set())}>
            Свернуть все
          </button>
        </div>
      )}

      {categories.map((c) => {
        const inCategory = people.filter((g) => (g.categoryId ?? null) === c.id);
        const shown = inCategory.filter((g) => shift === "all" || String(g.shift) === shift);
        const aa = new Map(c.allAround.map((r) => [r.gymnast.id, r]));
        const app = view === "AA" ? new Map() : new Map((c.apparatus[view] ?? []).map((r) => [r.gymnast.id, r]));
        const rankOf = (id: string) => (view === "AA" ? aa.get(id)?.rank : app.get(id)?.rank);
        const rows = [...shown].sort((a, b) => {
          const ra = rankOf(a.id) ?? Infinity;
          const rb = rankOf(b.id) ?? Infinity;
          return ra - rb || (a.shift ?? 99) - (b.shift ?? 99) || a.bib - b.bib;
        });
        const done =
          view === "AA"
            ? inCategory.filter((g) => aa.get(g.id)?.complete).length
            : inCategory.filter((g) => app.has(g.id)).length;
        const key = c.id ?? "none";
        return (
          <details
            key={key}
            className="wide progress-category"
            open={isOpen(key)}
            onToggle={(ev) => !single && toggle(key, ev.currentTarget.open)}
          >
            <summary>
              <h3>
                {c.name || "Без разряда"}{" "}
                <span className="muted">
                  · {view === "AA" ? "все снаряды прошли" : "выступили"}: {done} из {inCategory.length}
                </span>
              </h3>
            </summary>
            <div className="table-scroll">
              <table className={`draw-table progress-table ${view === "AA" ? "progress-aa" : "progress-one"}`}>
                <colgroup>
                  <col className="c-place" />
                  <col className="c-bib" />
                  <col />
                  <col className="c-club" />
                  <col className="c-shift" />
                  {(view === "AA" ? [...program, "sum"] : ["d", "e", "n", "t"]).map((k) => (
                    <col key={k} className="c-num" />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    <th>Место</th>
                    <th>№</th>
                    <th>Участник</th>
                    <th>Клуб</th>
                    <th>Смена</th>
                    {view === "AA" ? (
                      <>
                        {program.map((a) => (
                          <th key={a} className="num">
                            {APPARATUS_NAMES[a]}
                          </th>
                        ))}
                        <th className="num">Сумма</th>
                      </>
                    ) : (
                      <>
                        <th className="num">{labels.d}</th>
                        <th className="num">{labels.e}</th>
                        <th className="num">Сбавки</th>
                        <th className="num">Итог</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((g) => {
                    const r = aa.get(g.id);
                    const s = view === "AA" ? undefined : app.get(g.id)?.score;
                    const now = onApparatus.get(g.id);
                    const out = g.status !== "ACTIVE";
                    // Пустая графа у неявившегося или снятого — пометка вместо прочерка.
                    const blank = g.status === "DNS" ? "н/я" : g.status === "WITHDRAWN" ? "снят" : "—";
                    return (
                      <tr key={g.id} className={now ? "now" : out ? "out" : undefined}>
                        <td>{out ? GYMNAST_STATUS_NAMES[g.status] : (rankOf(g.id) ?? "")}</td>
                        <td>{g.bib}</td>
                        <td>
                          {g.lastName} {g.firstName}
                          {now && <span className="badge">сейчас: {APPARATUS_NAMES[now]}</span>}
                        </td>
                        <td>{g.club ?? ""}</td>
                        <td>{g.shift ?? ""}</td>
                        {view === "AA" ? (
                          <>
                            {program.map((a) => (
                              <td key={a} className="num">
                                {r?.apparatus[a] ? fmt(r.apparatus[a]!.total) : blank}
                              </td>
                            ))}
                            <td className="num">
                              <strong>{r ? fmt(r.total) : blank}</strong>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="num">{s ? fmt(s.d) : blank}</td>
                            <td className="num">{s ? fmt(s.e) : "—"}</td>
                            <td className="num">{s && s.neutral > 0 ? fmt(s.neutral) : "—"}</td>
                            <td className="num">
                              <strong>{s ? fmt(s.total) : blank}</strong>
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={view === "AA" ? 6 + program.length : 9} className="muted">
                        Нет участников
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </details>
        );
      })}
    </section>
  );
}

interface PresenceJudge {
  id: string;
  name: string;
  apparatus: string;
  role: "SUPERVISOR" | "D" | "E";
  seat: number;
  enterAllMarks: boolean;
}

interface JudgePresence {
  judgeId: string;
  online: boolean;
  since: string | null;
  lastSeen: string | null;
}

/** Как часто секретариат переспрашивает, кто на связи. */
const PRESENCE_POLL_MS = 5_000;

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Связь судей: чьи планшеты сейчас подключены к серверу, кто отключился и когда,
 * кто ещё не подключался. Судьи снаряда, где все оценки вводит старший судья, планшетов не держат.
 */
export function JudgesPresencePanel({
  competitionId,
  discipline,
  adminToken,
  onError,
  active,
}: Props & { active: boolean }) {
  const [judges, setJudges] = useState<PresenceJudge[]>([]);
  const [presence, setPresence] = useState<Map<string, JudgePresence>>(new Map());

  const load = useCallback(async () => {
    try {
      const [list, states] = await Promise.all([
        apiRequest<PresenceJudge[]>(`/competitions/${competitionId}/judges`, { token: adminToken }),
        apiRequest<JudgePresence[]>(`/competitions/${competitionId}/judges/presence`, { token: adminToken }),
      ]);
      setJudges(list);
      setPresence(new Map(states.map((p) => [p.judgeId, p])));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [competitionId, adminToken, onError]);

  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => void load(), PRESENCE_POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  if (judges.length === 0) return null;
  const singleTablet = new Set(judges.filter((j) => j.role === "SUPERVISOR" && j.enterAllMarks).map((j) => j.apparatus));
  const needsTablet = (j: PresenceJudge) => !singleTablet.has(j.apparatus) || j.role === "SUPERVISOR";
  const withTablets = judges.filter(needsTablet);
  const online = withTablets.filter((j) => presence.get(j.id)?.online).length;
  const lost = withTablets.filter((j) => !presence.get(j.id)?.online && presence.get(j.id)?.lastSeen).length;

  return (
    <section className="panel no-print judges-presence">
      <h2>Связь судей</h2>
      <p className="wide">
        <strong className={online === withTablets.length ? "ok-text" : "warning-text"}>
          На связи {online} из {withTablets.length}
        </strong>
        {lost > 0 && <span className="warning-text"> · отключились: {lost}</span>}
      </p>
      <div className="wide presence-grid">
        {apparatusFor(discipline)
          .filter((a) => judges.some((j) => j.apparatus === a))
          .map((a) => (
            <div key={a} className="presence-apparatus">
              <h3>
                <ApparatusIcon code={a} />
                {APPARATUS_NAMES[a]}
              </h3>
              <ul>
                {judges
                  .filter((j) => j.apparatus === a)
                  .sort((x, y) => Number(y.role === "SUPERVISOR") - Number(x.role === "SUPERVISOR"))
                  .map((j) => {
                    const p = presence.get(j.id);
                    const state = !needsTablet(j) ? "none" : p?.online ? "online" : p?.lastSeen ? "lost" : "never";
                    return (
                      <li key={j.id} className={`presence-${state}`}>
                        <span className="presence-dot" aria-hidden="true" />
                        <span className="presence-role">{j.role === "SUPERVISOR" ? "Старший" : judgeLabel(j.role, j.seat)}</span>
                        <span className="presence-name">{j.name}</span>
                        <span className="presence-state">
                          {state === "online" && `на связи${p?.since ? ` с ${clock(p.since)}` : ""}`}
                          {state === "lost" && `нет связи с ${clock(p!.lastSeen!)}`}
                          {state === "never" && "не подключался"}
                          {state === "none" && "без планшета"}
                        </span>
                      </li>
                    );
                  })}
              </ul>
            </div>
          ))}
      </div>
      <p className="muted wide">
        Обновляется каждые 5 секунд. Пропавший планшет отмечается примерно через 20 секунд; если судья закрыл страницу или
        планшет уснул, связь тоже пропадает, верните его на страницу судьи.
      </p>
    </section>
  );
}
