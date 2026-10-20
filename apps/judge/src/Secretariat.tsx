import { useCallback, useEffect, useMemo, useState } from "react";
import { apparatusFor, type Discipline } from "@ag/scoring";
import type { InquiryView, PerformanceView, RotationView } from "@ag/shared";
import { ApiError, apiRequest } from "./api";
import { APPARATUS_NAMES, parseScore } from "./labels";
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
}

interface Props {
  competitionId: string;
  discipline: Discipline;
  adminToken: string;
  onError: (message: string | null) => void;
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
    const query = byCategory && (categories.length > 1 || categories[0]?.id) ? `?category=${category}` : "";
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
export function InquiriesPanel({ competitionId, discipline, adminToken, onError }: Props) {
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
    if (claimedD === null) return onError("Оценка D: число до 20 с точностью до тысячных, например 5.400");
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
        `Новая оценка D для №${inquiry.gymnast.bib} ${inquiry.gymnast.lastName} (сейчас ${fmt(inquiry.previousD)})`,
        inquiry.claimedD !== null ? fmt(inquiry.claimedD) : "",
      );
      if (input === null) return;
      const d = parseScore(input.replace(",", ".").trim(), "D");
      if (d === null) return onError("Оценка D: число до 20 с точностью до тысячных, например 5.400");
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
        <h2>Запрос на пересмотр D</h2>
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
                {p.attempt > 1 ? `, прыжок ${p.attempt}` : ""} — D {fmt(p.score!.d)}, итог {fmt(p.score!.total)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Тренер
          <input name="coach" required />
        </label>
        <label>
          D по мнению тренера
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
                  D {fmt(q.previousD)}
                  {q.claimedD !== null && <div className="muted">просят {fmt(q.claimedD)}</div>}
                </td>
                <td>
                  {STATUS_NAMES[q.status]}
                  {q.newD !== null && q.newD !== q.previousD && <div className="muted">новая D {fmt(q.newD)}</div>}
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
}: Omit<Props, "discipline"> & { teamFormat: TeamFormat }) {
  const [text, setText] = useState("");
  const [people, setPeople] = useState<RosterGymnast[]>([]);
  const [teams, setTeams] = useState<Map<string, string>>(new Map());
  const [categories, setCategories] = useState<Map<string, string>>(new Map());
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

  const upload = async () => {
    try {
      await apiRequest(`/competitions/${competitionId}/gymnasts/import`, {
        token: adminToken,
        method: "POST",
        body: { rows: parsed.rows },
      });
      setText("");
      onError(null);
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <section className="panel roster no-print">
      <h2>Участники: {people.length}</h2>
      <label className="wide">
        Вставьте список из таблицы: № · Фамилия · Имя · Клуб · Команда · Разряд · Смена. Порядок строк в
        смене — порядок выхода.
        <textarea
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"12\tИванова\tАнна\tг. Тверь\tСШОР №1\t1 юношеский\t1\n13\tПетрова\tМария\tг. Тверь\tСШОР №1\t1 юношеский\t1"}
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
        <details className="wide">
          <summary>Список участников</summary>
          <table>
            <tbody>
              {people.map((g) => (
                <tr key={g.id}>
                  <td>№{g.bib}</td>
                  <td>
                    {g.lastName} {g.firstName}
                  </td>
                  <td className="muted">{g.club ?? ""}</td>
                  <td className="muted">{g.teamId ? teams.get(g.teamId) : ""}</td>
                  <td className="muted">{g.categoryId ? categories.get(g.categoryId) : ""}</td>
                  <td className="muted">{g.shift ? `смена ${g.shift}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
