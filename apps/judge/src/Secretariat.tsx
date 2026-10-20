import { useCallback, useEffect, useMemo, useState } from "react";
import { apparatusFor, type Discipline } from "@ag/scoring";
import { GYMNAST_STATUSES, GYMNAST_STATUS_NAMES, JUDGE_CATEGORIES, type GymnastStatus, type Official } from "@ag/shared";
import type { ClubStandingView, DrawView, FinalsView, InquiryView, NormativesView, PerformanceView, RotationView, Rules, RulesView } from "@ag/shared";
import { ApiError, apiRequest } from "./api";
import { APPARATUS_NAMES, parsePoints, parseScore } from "./labels";
import { parseRoster, teamFormatWarnings, type TeamFormat } from "./roster";

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

  const load = useCallback(async () => {
    try {
      const [rotation, perfs] = await Promise.all([
        apiRequest<RotationView>(`/competitions/${competitionId}/rotation`),
        apiRequest<PerformanceView[]>(`/competitions/${competitionId}/performances`, { token: adminToken }),
      ]);
      setView(rotation);
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
            <th>Начинает на</th>
            <th>Сейчас на снаряде</th>
            <th>Выступили</th>
          </tr>
        </thead>
        <tbody>
          {progress.map((s) => (
            <tr key={s.number}>
              <td>{s.number}</td>
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
                <strong>{APPARATUS_NAMES[s.apparatus]}</strong>
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
      const response = await fetch(`/competitions/${competitionId}/protocols/${path}${query}`, {
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
  const [gymnasts, setGymnasts] = useState<Map<string, Gymnast>>(new Map());
  const [inquiries, setInquiries] = useState<InquiryView[]>([]);

  const load = useCallback(async () => {
    try {
      const [perfs, people, list] = await Promise.all([
        apiRequest<PerformanceView[]>(`/competitions/${competitionId}/performances?apparatus=${apparatus}`, {
          token: adminToken,
        }),
        apiRequest<Gymnast[]>(`/competitions/${competitionId}/gymnasts`),
        apiRequest<InquiryView[]>(`/competitions/${competitionId}/inquiries`, { token: adminToken }),
      ]);
      // Свежие оценки сверху: запрос обычно подают на только что показанную.
      setPerformances(perfs.filter((p) => p.status === "APPROVED").reverse());
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
    try {
      await apiRequest(`/performances/${String(form.get("performanceId"))}/inquiries`, {
        token: adminToken,
        method: "POST",
        body: { coach: String(form.get("coach")), ...(claimedD !== undefined ? { claimedD } : {}) },
      });
      onError(null);
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
          <select value={apparatus} onChange={(e) => setApparatus(e.target.value)}>
            {apparatusFor(discipline).map((a) => (
              <option key={a} value={a}>
                {APPARATUS_NAMES[a]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Выступление
          <select name="performanceId" required>
            {performances.length === 0 && <option value="">Утверждённых оценок нет</option>}
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
      const created = await apiRequest<CompetitionCreated>("/competitions", {
        token: adminToken,
        method: "POST",
        body: {
          name: String(form.get("name")).trim(),
          discipline: String(form.get("discipline")),
          teamFormat: {
            roster: Number(form.get("roster")),
            perApparatus: Number(form.get("perApparatus")),
            counting: Number(form.get("counting")),
          },
          publishJudgeMarks: form.get("publishJudgeMarks") === "on",
          rules: String(form.get("rules")),
        },
      });
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

/** Участники: вставка списка из таблицы и проверка перед загрузкой. */
export function RosterPanel({
  competitionId,
  teamFormat,
  adminToken,
  onError,
  onImported,
}: Omit<Props, "discipline"> & { teamFormat: TeamFormat; onImported?: () => void }) {
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

  const upload = async () => {
    try {
      await apiRequest(`/competitions/${competitionId}/gymnasts/import`, {
        token: adminToken,
        method: "POST",
        body: { rows: parsed.rows },
      });
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
          Столбцы узнаются по заголовкам: Фамилия, Имя (или ФИО), Отчество, Дата рождения, Клуб, Город, Тренер, Команда, Разряд, Смена, Стартовый номер.
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
      <label className="wide">
        Вставьте список из таблицы: № · Фамилия · Имя · Клуб · Команда · Разряд · Смена · Дата рождения · Город ·
        Тренер · Отчество. Обязательны первые три столбца. Порядок строк в смене — порядок выхода.
        <textarea
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"12\tИванова\tАнна\tСШОР №1\tСШОР №1\t1 юношеский\t1\t15.03.2014\tТверь\tСмирнова О. В.\n13\tПетрова\tМария\tСШОР №1\tСШОР №1\t1 юношеский\t1\t2014\tТверь"}
        />
      </label>
      {parsed.errors.length > 0 && <div className="alert wide">{parsed.errors.join("; ")}</div>}
      {warnings.map((w) => (
        <div key={w} className="warning wide">
          {w}
        </div>
      ))}
      <button
        type="button"
        className="primary"
        disabled={parsed.rows.length === 0 || parsed.errors.length > 0}
        onClick={() => void upload()}
      >
        Добавить {parsed.rows.length > 0 ? `${parsed.rows.length} уч.` : ""}
      </button>
      {people.length > 0 && (
        <details className="wide" open={people.some((g) => g.status !== "ACTIVE")}>
          <summary>
            Список участников: правка, неявка, снятие
            {people.some((g) => g.status !== "ACTIVE") &&
              ` (не выступают: ${people.filter((g) => g.status !== "ACTIVE").length})`}
          </summary>
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
  const [saved, setSaved] = useState(false);
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
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const setBase = (id: string, change: (d: BaseDraft) => BaseDraft) =>
    setBases((all) => ({ ...all, [id]: change(all[id] ?? { base: "", apparatus: {} }) }));

  if (!view) return null;
  return (
    <section className="panel no-print rules">
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
                            placeholder="10.000"
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
      <button type="button" className="primary" disabled={problems.length > 0} onClick={() => void save()}>
        {saved ? "Сохранено" : "Сохранить правила"}
      </button>
    </section>
  );
}

interface DrawGymnast extends RosterGymnast {
  startOrder: number | null;
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
        <table className="draw-table">
          <thead>
            <tr>
              <th>Смена</th>
              <th>№</th>
              <th>Участник</th>
              <th>Клуб · команда</th>
              <th>Разряд</th>
            </tr>
          </thead>
          <tbody>
            {people.map((g) => (
              <tr key={g.id} className={repeated.includes(g) || invalid.includes(g) ? "invalid" : undefined}>
                <td className="muted">{g.shift ?? "—"}</td>
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

/**
 * Общекомандный зачёт: очки клубам за места в многоборье, на снарядах и команд
 * по таблицам из положения. Ниже — текущая таблица клубов.
 */
export function ClubStandingPanel({ competitionId, adminToken, onError }: Omit<Props, "discipline">) {
  const [view, setView] = useState<ClubStandingView | null>(null);
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
    <section className="panel no-print club-standing">
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
      <button type="button" className="primary" disabled={busy || !valid} onClick={() => void save()}>
        Сохранить и пересчитать
      </button>
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
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel no-print officials">
      <h2>Главная судейская коллегия</h2>
      <p className="muted wide">Печатается в подписях под протоколами и на грамотах.</p>
      {row("Главный судья", judge, setJudge)}
      {row("Главный секретарь", secretary, setSecretary)}
      <datalist id="official-categories">
        {JUDGE_CATEGORIES.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
        Сохранить
      </button>
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
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel no-print normatives">
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
      <button type="button" className="primary" disabled={busy || invalid} onClick={() => void save()}>
        Сохранить нормативы
      </button>
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
