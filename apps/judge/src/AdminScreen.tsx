import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { apparatusFor, type Discipline } from "@ag/scoring";
import { JUDGE_CATEGORIES, type JudgeRole, type Official, type Rules } from "@ag/shared";
import { ChiefJudgePanel } from "./ChiefJudge";
import { UpdateNotice, VersionLine } from "./Updates";
import { ApiError, apiRequest } from "./api";
import { copyText } from "./clipboard";
import { APPARATUS_NAMES, ROLE_NAMES, judgeLabel } from "./labels";
import {
  DrawPanel,
  FinalsPanel,
  NormativesPanel,
  ClubStandingPanel,
  CeremonyPanel,
  HallBoardPanel,
  AuditPanel,
  ShiftsPanel,
  ManualScoresPanel,
  RecoveryPanel,
  ReadinessPanel,
  AnnouncerLinkPanel,
  BoardTimerPanel,
  StandbyPanel,
  OnlineEntriesPanel,
  SeriesPanel,
  SiteProtocolsPanel,
  JudgesPresencePanel,
  SiteBadge,
  SitePanel,
  OfficialsPanel,
  ProgressPanel,
  InquiriesPanel,
  NewCompetitionForm,
  DemoCompetitionForm,
  ImportCompetitionForm,
  TransferPanel,
  ProtocolsPanel,
  RosterPanel,
  RotationPanel,
  RulesPanel,
} from "./Secretariat";

interface Competition {
  id: string;
  name: string;
  discipline: Discipline;
  teamRoster: number;
  teamPerApparatus: number;
  teamCounting: number;
  rules: Rules;
  officials?: { chiefJudge: Official | null; chiefSecretary: Official | null };
  /** Девочки и мальчики одного турнира: у обеих частей один pairId. */
  pairId?: string | null;
  /** Пробный турнир для репетиции. */
  trial?: boolean;
}

const PART_NAMES: Record<string, string> = { WAG: "Девочки", MAG: "Мальчики" };

interface Judge {
  id: string;
  name: string;
  apparatus: string;
  role: JudgeRole;
  seat: number;
  /** Судейская категория: ВК, 1К, 2К, 3К, ЮС. */
  category?: string | null;
  /** Планшет снаряда: старший судья вводит оценки всей бригады. */
  enterAllMarks: boolean;
}

interface IssuedJudge extends Judge {
  token: string;
}

const ADMIN_KEY = "admin-token";

/** Экраны секретариата; выбранный экран виден в адресе (#/admin/roster) и переживает обновление страницы. */
const TABS = [
  { id: "competition", title: "Соревнование" },
  { id: "roster", title: "Участники" },
  { id: "judges", title: "Судьи" },
  { id: "progress", title: "Ход соревнования" },
  { id: "chief", title: "Главный судья" },
  { id: "finals", title: "Финалы и награждение" },
  { id: "protocols", title: "Протоколы" },
] as const;
type Tab = (typeof TABS)[number]["id"];

function tabFromHash(): Tab | null {
  const id = location.hash.replace(/^#\/admin\/?/, "");
  return TABS.find((t) => t.id === id)?.id ?? null;
}

function loginUrl(token: string): string {
  return `${location.origin}/judge/#token=${encodeURIComponent(token)}`;
}

/** Секретариат открыт по адресу localhost: ссылки и QR-коды с ним не откроются на других устройствах. */
const LOCAL_ONLY = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

function judgeTitle(judge: Judge): string {
  return `${APPARATUS_NAMES[judge.apparatus]}, ${judgeLabel(judge.role, judge.seat)}`;
}

/** Таблица ссылок для Excel: точка с запятой и BOM, чтобы русский Excel открыл её по колонкам и без «кракозябр». */
function linksCsv(list: IssuedJudge[]): string {
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = [
    ["Снаряд", "Роль", "ФИО", "Категория", "Ссылка для входа"],
    ...list.map((j) => [APPARATUS_NAMES[j.apparatus] ?? j.apparatus, judgeLabel(j.role, j.seat), j.name, j.category ?? "", loginUrl(j.token)]),
  ];
  return "\uFEFF" + rows.map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
}

/** Секретариат: судьи и их QR-коды, протоколы, запросы тренеров на пересмотр D. */
export function AdminScreen() {
  const [adminToken, setAdminToken] = useState(() => sessionStorage.getItem(ADMIN_KEY) ?? "");
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [competitionId, setCompetitionId] = useState("");
  const [judges, setJudges] = useState<Judge[]>([]);
  const [newRole, setNewRole] = useState<JudgeRole>("D");
  const [newSingle, setNewSingle] = useState(false);
  const [issued, setIssued] = useState<IssuedJudge[]>([]);
  /** Судьи, чей код не восстановить (выдан до обновления): им нужен «Новый QR-код». */
  const [lostCodes, setLostCodes] = useState<Judge[]>([]);
  /** Ссылки судей текстом: для компьютеров без камеры, чтобы разослать судьям. */
  const [links, setLinks] = useState<IssuedJudge[]>([]);
  /** Сообщение после копирования ссылки. */
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => tabFromHash() ?? "competition");
  // Растёт после загрузки участников: в правилах появляются новые разряды.
  const [rosterVersion, setRosterVersion] = useState(0);
  // Растёт после жеребьёвки: списку участников и сменам нужны новые номера.
  const [drawVersion, setDrawVersion] = useState(0);

  const competition = competitions.find((c) => c.id === competitionId);
  // Вторая часть турнира (девочки или мальчики), если она есть.
  const partner = competition?.pairId
    ? competitions.find((c) => c.pairId === competition.pairId && c.id !== competition.id)
    : undefined;
  // В списке турнир из двух частей — одна строка: по первой созданной части.
  const listed = competitions.filter(
    (c) => !c.pairId || competitions.find((o) => o.pairId === c.pairId)?.id === c.id,
  );
  const listedId = competition?.pairId
    ? (competitions.find((c) => c.pairId === competition.pairId)?.id ?? competitionId)
    : competitionId;

  const loadCompetitions = useCallback(async (select?: string) => {
    try {
      const list = await apiRequest<Competition[]>("/competitions");
      setCompetitions(list);
      if (select) setCompetitionId(select);
      // Турнир девочек и мальчиков открывается с девочек.
      else if (list.length > 0) setCompetitionId((id) => id || (list.find((c) => c.pairId && c.pairId === list.at(-1)!.pairId) ?? list.at(-1)!).id);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadCompetitions();
  }, [loadCompetitions]);

  const loadJudges = useCallback(async () => {
    if (!competitionId || !adminToken) return;
    try {
      setJudges(await apiRequest<Judge[]>(`/competitions/${competitionId}/judges`, { token: adminToken }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [competitionId, adminToken]);

  useEffect(() => {
    void loadJudges();
  }, [loadJudges]);

  // Если экран не выбран, а соревнование уже есть, при открытии начинаем с хода соревнования.
  const defaultTab = useRef(tabFromHash() === null);
  useEffect(() => {
    if (defaultTab.current && competitions.length > 0) {
      defaultTab.current = false;
      setTab("progress");
    }
  }, [competitions.length]);
  useEffect(() => {
    const onHash = () => {
      const next = tabFromHash();
      if (next) setTab(next);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const openTab = (id: Tab) => {
    defaultTab.current = false;
    setTab(id);
    setError(null);
    history.replaceState(null, "", `#/admin/${id}`);
    scrollTo({ top: 0 });
  };

  const remember = useCallback((token: string) => {
    setAdminToken(token);
    if (token) sessionStorage.setItem(ADMIN_KEY, token);
    else sessionStorage.removeItem(ADMIN_KEY);
  }, []);

  const addJudge = async (form: FormData) => {
    const post = (body: Record<string, unknown>) =>
      apiRequest<IssuedJudge>(`/competitions/${competitionId}/judges`, { token: adminToken, method: "POST", body });
    const apparatus = String(form.get("apparatus"));
    const role = String(form.get("role"));
    const single = role === "SUPERVISOR" && form.get("enterAllMarks") === "on";
    try {
      const created = [
        await post({
          name: String(form.get("name")),
          ...(String(form.get("category") ?? "").trim() ? { category: String(form.get("category")).trim() } : {}),
          apparatus,
          role,
          seat: Number(form.get("seat")),
          enterAllMarks: single,
        }),
      ];
      // Один планшет: бригаду можно завести тут же списком — первая строка судья D (если D есть), дальше E1, E2…
      if (single) {
        const names = String(form.get("brigade") ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const withD = competition?.rules !== "CUSTOM";
        for (const [i, name] of names.entries()) {
          const isD = withD && i === 0;
          created.push(await post({ name, apparatus, role: isD ? "D" : "E", seat: isD ? 1 : withD ? i : i + 1 }));
        }
      }
      // Если на снаряде один планшет, судьям D и E QR-коды не нужны: оценки за них вводит старший.
      const tabletApparatus = new Set(
        [...judges, ...created].filter((j) => j.enterAllMarks).map((j) => j.apparatus),
      );
      setIssued((list) =>
        [...list, ...created].filter((j) => j.role === "SUPERVISOR" || !tabletApparatus.has(j.apparatus)),
      );
      setError(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      await loadJudges();
    }
  };

  /** Прежние коды всех судей: перевыпускать не нужно, планшеты остаются в работе. */
  const loadCodes = async () => {
    const codes = await apiRequest<(Judge & { token: string | null })[]>(`/competitions/${competition!.id}/judges/codes`, {
      token: adminToken,
    });
    // Если на снаряде один планшет, судьям D и E коды не нужны: оценки за них вводит старший.
    const tabletApparatus = new Set(codes.filter((j) => j.enterAllMarks).map((j) => j.apparatus));
    const needed = codes.filter((j) => j.role === "SUPERVISOR" || !tabletApparatus.has(j.apparatus));
    setLostCodes(needed.filter((j) => j.token === null));
    return { codes, needed: needed.filter((j): j is IssuedJudge => j.token !== null) };
  };

  /** Все QR-коды для печати. */
  const showAllCodes = async () => {
    if (!competition) return;
    try {
      const { needed } = await loadCodes();
      setIssued(needed);
      setLinks([]);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Все ссылки списком: для судей за компьютером без камеры. */
  const showAllLinks = async () => {
    if (!competition) return;
    try {
      const { needed } = await loadCodes();
      // Как в списке судей: снаряды по порядку соревнований, в бригаде старший, затем D и E.
      const order: readonly string[] = apparatusFor(competition.discipline);
      setLinks(
        [...needed].sort(
          (a, b) =>
            order.indexOf(a.apparatus) - order.indexOf(b.apparatus) ||
            ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
            a.seat - b.seat,
        ),
      );
      setIssued([]);
      setCopied(null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Ссылка одного судьи в буфер обмена. */
  const copyLink = async (judge: Judge) => {
    if (!competition) return;
    try {
      const { codes } = await loadCodes();
      const token = codes.find((j) => j.id === judge.id)?.token;
      if (!token) {
        setError(`Ссылку ${judge.name} показать нельзя: код выдан до обновления программы. Нажмите у судьи «Новый QR-код» один раз.`);
        return;
      }
      const url = loginUrl(token);
      const ok = await copyText(url);
      setCopied(ok ? `Ссылка для ${judge.name} (${judgeTitle(judge)}) скопирована: ${url}` : `Скопируйте ссылку для ${judge.name} вручную: ${url}`);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const copyAllLinks = async () => {
    const text = links.map((j) => `${judgeTitle(j)} — ${j.name}: ${loginUrl(j.token)}`).join("\n");
    setCopied((await copyText(text)) ? `Скопированы ссылки всех судей (${links.length}).` : "Не удалось скопировать: выделите таблицу и скопируйте вручную.");
  };

  const downloadLinks = () => {
    const url = URL.createObjectURL(new Blob([linksCsv(links)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    // Латинское имя файла, как у протоколов: кириллицу в имени некоторые браузеры заменяют на «download».
    a.download = "judge-links.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const reissue = async (judge: Judge) => {
    if (!confirm(`Выдать ${judge.name} новый QR-код? Старый перестанет работать.`)) return;
    try {
      const fresh = await apiRequest<IssuedJudge>(`/judges/${judge.id}/token`, { token: adminToken, method: "POST" });
      setIssued((list) => [...list.filter((j) => j.id !== judge.id), fresh]);
      setLinks((list) => list.map((j) => (j.id === fresh.id ? { ...j, ...fresh } : j)));
      setLostCodes((list) => list.filter((j) => j.id !== judge.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveJudge = async (judge: Judge, changes: Partial<Judge>) => {
    try {
      const saved = await apiRequest<Judge>(`/judges/${judge.id}`, { token: adminToken, method: "PATCH", body: changes });
      setIssued((list) => list.map((j) => (j.id === saved.id ? { ...j, ...saved } : j)));
      setLinks((list) => list.map((j) => (j.id === saved.id ? { ...j, ...saved } : j)));
      await loadJudges();
      setError(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const removeJudge = async (judge: Judge) => {
    if (!confirm(`Удалить судью ${judge.name} (${APPARATUS_NAMES[judge.apparatus]}, ${judgeLabel(judge.role, judge.seat)})? Его QR-код перестанет работать.`)) return;
    try {
      await apiRequest(`/judges/${judge.id}`, { token: adminToken, method: "DELETE" });
      setIssued((list) => list.filter((j) => j.id !== judge.id));
      setLinks((list) => list.filter((j) => j.id !== judge.id));
      await loadJudges();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const ready = Boolean(competition && adminToken);
  const pane = (id: Tab) => ({ hidden: tab !== id, className: "admin-pane" });

  return (
    <div className="screen admin">
      <header className="bar no-print">
        <div className="apparatus">Секретариат</div>
        <SiteBadge adminToken={adminToken} />
      </header>
      <section className="panel no-print">
        <AccessPanel adminToken={adminToken} onToken={remember} />
        <label>
          Соревнование
          <select value={listedId} onChange={(e) => setCompetitionId(e.target.value)}>
            {listed.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({competitions.some((o) => o.pairId && o.pairId === c.pairId && o.id !== c.id) ? "женская и мужская" : c.discipline})
              </option>
            ))}
          </select>
        </label>
      </section>
      {competition && partner && (
        <div className="part-switch no-print" role="group" aria-label="Часть турнира">
          {[competition, partner]
            .sort((a, b) => (a.discipline === "WAG" ? -1 : b.discipline === "WAG" ? 1 : 0))
            .map((c) => (
              <button
                key={c.id}
                type="button"
                className={c.id === competitionId ? "active" : undefined}
                aria-pressed={c.id === competitionId}
                onClick={() => setCompetitionId(c.id)}
              >
                {PART_NAMES[c.discipline] ?? c.name}
              </button>
            ))}
        </div>
      )}

      <nav className="admin-tabs no-print" aria-label="Экраны секретариата">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? "active" : undefined}
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => openTab(t.id)}
          >
            {t.title}
          </button>
        ))}
      </nav>

      {adminToken && <UpdateNotice adminToken={adminToken} />}
      {error && <div className="alert no-print">{error}</div>}
      {!adminToken && (
        <div className="alert no-print">
          Войдите паролем секретариата. Если пароль ещё не задан или забыт, войдите токеном из окна запуска сервера.
        </div>
      )}

      <div {...pane("competition")}>
        {adminToken && <LicensePanel adminToken={adminToken} />}
        {adminToken && (
          <details className="no-print new-competition" open={competitions.length === 0}>
            <summary>Новое соревнование</summary>
            <NewCompetitionForm
              adminToken={adminToken}
              onError={setError}
              onCreated={(id) => {
                setIssued([]);
                setLostCodes([]);
                void loadCompetitions(id);
              }}
            />
          </details>
        )}
        {adminToken && (
          <details className="no-print new-competition">
            <summary>Загрузить турнир из файла</summary>
            <ImportCompetitionForm
              adminToken={adminToken}
              onError={setError}
              onImported={(id) => {
                setIssued([]);
                setLostCodes([]);
                void loadCompetitions(id);
              }}
            />
          </details>
        )}
        {adminToken && (
          <details className="no-print new-competition">
            <summary>Запасной ноутбук</summary>
            <StandbyPanel adminToken={adminToken} onError={setError} onTakenOver={(id) => void loadCompetitions(id)} />
          </details>
        )}
        {adminToken && (
          <details className="no-print new-competition">
            <summary>Пробный турнир для репетиции</summary>
            <DemoCompetitionForm<IssuedJudge>
              adminToken={adminToken}
              onError={setError}
              onCreated={(id, supervisors) => {
                setIssued(supervisors);
                void loadCompetitions(id);
              }}
            />
          </details>
        )}
        {ready && competition && (
          <>
            <SitePanel
              key={`site-now-${competition.id}`}
              partnerId={partner?.id}
              competitionId={competition.id}
              competitions={competitions}
              adminToken={adminToken}
              onError={setError}
            />
            <RulesPanel
              key={`rules-${competition.id}-${rosterVersion}`}
              competitionId={competition.id}
              discipline={competition.discipline}
              adminToken={adminToken}
              onError={setError}
              onSaved={() => void loadCompetitions(competition.id)}
            />
            <NormativesPanel
              key={`normatives-${competition.id}-${rosterVersion}`}
              competitionId={competition.id}
              adminToken={adminToken}
              onError={setError}
            />
            <OfficialsPanel
              key={`officials-${competition.id}`}
              competitionId={competition.id}
              officials={competition.officials}
              adminToken={adminToken}
              onError={setError}
              onSaved={() => void loadCompetitions(competition.id)}
            />
            <TransferPanel
              key={`transfer-${competition.id}`}
              competitionId={competition.id}
              name={competition.name}
              trial={competition.trial ?? false}
              adminToken={adminToken}
              onError={setError}
              onDeleted={() => {
                setIssued([]);
                setLostCodes([]);
                setCompetitionId("");
                void loadCompetitions();
              }}
            />
          </>
        )}
        {adminToken && (
          <SeriesPanel key={`series-${competitions.length}`} competitions={competitions} adminToken={adminToken} onError={setError} />
        )}
        {adminToken && <VersionLine adminToken={adminToken} />}
      </div>

      {ready && competition && (
        <>
          <div {...pane("roster")}>
            {/* Турнир девочек и мальчиков принимает заявки одной ссылкой: на обеих частях одна панель. */}
            <OnlineEntriesPanel
              key={`online-${competition.pairId ?? competition.id}`}
              competitionId={competition.pairId ?? competition.id}
              mixed={Boolean(partner)}
              adminToken={adminToken}
              onError={setError}
              onAccepted={() => {
                setDrawVersion((v) => v + 1);
                setRosterVersion((v) => v + 1);
              }}
            />
            <RosterPanel
              key={`${competition.id}-${drawVersion}`}
              competitionId={competition.id}
              discipline={competition.discipline}
              partner={partner}
              teamFormat={{
                roster: competition.teamRoster,
                perApparatus: competition.teamPerApparatus,
                counting: competition.teamCounting,
              }}
              adminToken={adminToken}
              onError={setError}
              onImported={() => setRosterVersion((v) => v + 1)}
            />
            <ShiftsPanel
              key={`shifts-${competition.id}-${rosterVersion}-${drawVersion}`}
              competitionId={competition.id}
              adminToken={adminToken}
              onError={setError}
              onChanged={() => {
                setDrawVersion((v) => v + 1);
                setRosterVersion((v) => v + 1);
              }}
            />
            <DrawPanel
              key={`draw-${competition.id}-${rosterVersion}`}
              competitionId={competition.id}
              adminToken={adminToken}
              onError={setError}
              onDrawn={() => setDrawVersion((v) => v + 1)}
            />
          </div>

          <div {...pane("judges")}>
            {competition && adminToken && (
              <form
                className="panel no-print"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  void addJudge(new FormData(form)).then((ok) => {
                    if (!ok) return;
                    // Снаряд и роль остаются: следующего судью той же бригады заводить быстрее.
                    for (const name of ["name", "category", "brigade"]) {
                      const field = form.elements.namedItem(name) as HTMLInputElement | null;
                      if (field) field.value = "";
                    }
                  });
                }}
              >
                <h2>Судьи и QR-коды</h2>
                <label>
                  ФИО судьи
                  <input name="name" required />
                </label>
                <label>
                  Категория
                  <input name="category" list="judge-categories" placeholder="ВК, 1К, 2К, 3К, ЮС" />
                </label>
                <datalist id="judge-categories">
                  {JUDGE_CATEGORIES.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
                <label>
                  Снаряд
                  <select name="apparatus">
                    {apparatusFor(competition.discipline).map((a) => (
                      <option key={a} value={a}>
                        {APPARATUS_NAMES[a]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Роль
                  <select name="role" value={newRole} onChange={(e) => setNewRole(e.target.value as JudgeRole)}>
                    {(Object.keys(ROLE_NAMES) as JudgeRole[]).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_NAMES[r]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Место в бригаде
                  <input name="seat" type="number" min={1} max={10} defaultValue={1} required />
                </label>
                {newRole === "SUPERVISOR" && (
                  <label className="check wide">
                    <input name="enterAllMarks" type="checkbox" checked={newSingle} onChange={(e) => setNewSingle(e.target.checked)} />
                    Один планшет на снаряд: старший судья вводит оценки всей бригады (судьям D и E QR-коды не нужны)
                  </label>
                )}
                {newRole === "SUPERVISOR" && newSingle && (
                  <label className="wide">
                    Судьи бригады, по одному в строке: {competition.rules === "CUSTOM" ? "E1, E2, E3…" : "сначала судья D, затем E1, E2, E3…"}
                    <textarea
                      name="brigade"
                      rows={5}
                      placeholder={competition.rules === "CUSTOM" ? "Петрова Н.\nСидорова Т.\nКузнецова Е." : "Петрова Н.\nСидорова Т.\nКузнецова Е.\nСмирнова А."}
                    />
                    <span className="muted">
                      Их фамилии и оценки идут в протокол, поэтому планшет без них не откроется. Можно оставить пустым и завести
                      каждого отдельно с ролью «Судья D» или «Судья E».
                    </span>
                  </label>
                )}
                <button type="submit" className="primary">
                  Добавить судью
                </button>
              </form>
            )}

            <JudgesPresencePanel
              key={`presence-judges-${competition.id}-${judges.length}`}
              competitionId={competition.id}
              discipline={competition.discipline}
              adminToken={adminToken}
              onError={setError}
              active={tab === "judges"}
            />

            {judges.length > 0 && (
              <JudgesByApparatus
                judges={judges}
                discipline={competition.discipline}
                renderRow={(j) => (
                  <JudgeRow
                    key={j.id}
                    judge={j}
                    grouped
                    discipline={competition.discipline}
                    onSave={(changes) => saveJudge(j, changes)}
                    onRemove={() => void removeJudge(j)}
                    onReissue={() => void reissue(j)}
                    onCopyLink={() => void copyLink(j)}
                  />
                )}
              />
            )}

            {judges.length > 0 && (
              <div className="no-print qr-actions">
                <button type="button" onClick={() => void showAllCodes()}>
                  Показать QR-коды всех судей
                </button>
                <button type="button" onClick={() => void showAllLinks()}>
                  Ссылки всех судей (для компьютеров)
                </button>
                <span className="muted">
                  Коды и ссылки прежние, планшеты продолжают работать. Если у судьи компьютер без камеры, отправьте ему
                  ссылку: он откроет её в браузере вместо QR-кода. Если на снаряде один планшет, нужен только код старшего
                  судьи.
                </span>
              </div>
            )}
            {judges.length > 0 && LOCAL_ONLY && (
              <p className="warning no-print">
                Секретариат открыт по адресу {location.host}: с такими QR-кодами и ссылками планшеты и компьютеры судей не
                подключатся. Откройте секретариат по адресу из окна «Запуск» (вида http://192.168…:3000/judge/#/admin).
              </p>
            )}
            {copied && <p className="notice no-print copied-link">{copied}</p>}
            {lostCodes.length > 0 && (
              <p className="warning no-print">
                Эти коды выданы до обновления программы, и показать их снова нельзя:{" "}
                {lostCodes.map((j) => `${j.name} (${APPARATUS_NAMES[j.apparatus]})`).join(", ")}. Нажмите у них «Новый QR-код»
                один раз, дальше их коды можно будет перепечатывать.
              </p>
            )}

            {links.length > 0 && (
              <div className="judge-links">
                <div className="no-print qr-actions">
                  <button type="button" className="primary" onClick={downloadLinks}>
                    Скачать таблицу (Excel)
                  </button>
                  <button type="button" onClick={() => void copyAllLinks()}>
                    Копировать все ссылки
                  </button>
                  <button type="button" onClick={() => print()}>
                    Печать
                  </button>
                  <button type="button" onClick={() => setLinks([])}>
                    Скрыть
                  </button>
                </div>
                <p className="muted no-print">
                  Судья открывает свою ссылку в браузере (Chrome, Edge, Яндекс) на компьютере, подключённом к той же сети, что и
                  этот ноутбук. Ссылка — как пароль: отправляйте каждому только его строку.
                </p>
                <h2 className="print-only">{competition.name}: ссылки для входа судей</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Снаряд</th>
                      <th>Роль</th>
                      <th>ФИО</th>
                      <th>Ссылка для входа</th>
                      <th className="no-print" />
                    </tr>
                  </thead>
                  <tbody>
                    {links.map((j) => (
                      <tr key={j.id + j.token}>
                        <td>{APPARATUS_NAMES[j.apparatus]}</td>
                        <td>{judgeLabel(j.role, j.seat)}</td>
                        <td>{j.name}</td>
                        <td className="link-cell">{loginUrl(j.token)}</td>
                        <td className="no-print">
                          <button type="button" className="link" onClick={() => void copyLink(j)}>
                            Копировать
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {issued.length > 0 && (
              <>
                <div className="no-print">
                  <button type="button" className="primary" onClick={() => print()}>
                    Печать QR-кодов
                  </button>
                  <p className="muted">Если планшет потерян, выдайте судье новый код: старый перестанет работать.</p>
                </div>
                <div className="qr-grid">
                  {issued.map((j) => (
                    <QrCard key={j.id + j.token} judge={j} />
                  ))}
                </div>
              </>
            )}
          </div>

          <div {...pane("progress")}>
            <ReadinessPanel
              key={`readiness-${competition.id}`}
              competitionId={competition.id}
              adminToken={adminToken}
              onError={setError}
              active={tab === "progress"}
            />
            {partner && (
              <HallBoardPanel
                key={`hall-board-${competition.id}`}
                competitionId={competition.id}
                parts={[competition, partner]
                  .sort((a, b) => (a.discipline === "WAG" ? -1 : b.discipline === "WAG" ? 1 : 0))
                  .map((c) => ({ id: c.id, label: PART_NAMES[c.discipline] ?? c.name }))}
                adminToken={adminToken}
                onError={setError}
              />
            )}
            <BoardTimerPanel key={`timer-${competition.id}`} competitionId={competition.id} adminToken={adminToken} onError={setError} />
            <JudgesPresencePanel
              key={`presence-${competition.id}`}
              competitionId={competition.id}
              discipline={competition.discipline}
              adminToken={adminToken}
              onError={setError}
              active={tab === "progress"}
            />
            <RotationPanel
              key={`rotation-${competition.id}-${drawVersion}`}
              competitionId={competition.id}
              discipline={competition.discipline}
              adminToken={adminToken}
              onError={setError}
            />
            <ManualScoresPanel
              key={`manual-${competition.id}`}
              competitionId={competition.id}
              discipline={competition.discipline}
              rules={competition.rules}
              adminToken={adminToken}
              onError={setError}
              active={tab === "progress"}
            />
            <AnnouncerLinkPanel key={`announcer-${competition.id}`} competitionId={competition.id} />
            <RecoveryPanel
              key={`recovery-${competition.id}`}
              competitionId={competition.id}
              adminToken={adminToken}
              onError={setError}
            />
            <ProgressPanel
              key={`progress-${competition.id}`}
              competitionId={competition.id}
              discipline={competition.discipline}
              active={tab === "progress"}
              onError={setError}
            />
          </div>

          <div {...pane("chief")}>
            <ChiefJudgePanel
              key={`chief-${competition.id}`}
              competitionId={competition.id}
              discipline={competition.discipline}
              adminToken={adminToken}
              onError={setError}
              active={tab === "chief"}
            />
          </div>

          <div {...pane("finals")}>
            <FinalsPanel key={`finals-${competition.id}`} competitionId={competition.id} adminToken={adminToken} onError={setError} />
            <InquiriesPanel
              key={competition.id}
              competitionId={competition.id}
              discipline={competition.discipline}
              rules={competition.rules}
              adminToken={adminToken}
              onError={setError}
            />
            <CeremonyPanel
              key={`ceremony-${competition.id}`}
              competitionId={competition.id}
              discipline={competition.discipline}
              adminToken={adminToken}
              onError={setError}
            />
            <ClubStandingPanel key={`clubs-${competition.id}`} competitionId={competition.id} adminToken={adminToken} onError={setError} />
          </div>

          <div {...pane("protocols")}>
            <ProtocolsPanel
              competitionId={competition.id}
              discipline={competition.discipline}
              adminToken={adminToken}
              onError={setError}
            />
            <SiteProtocolsPanel key={`site-${competition.id}`} competitionId={competition.id} adminToken={adminToken} onError={setError} />
            <AuditPanel
              key={`audit-${competition.id}`}
              competitionId={competition.id}
              adminToken={adminToken}
              onError={setError}
              active={tab === "protocols"}
            />
          </div>
        </>
      )}
      {adminToken && !competition && tab !== "competition" && (
        <p className="panel no-print muted">Сначала создайте соревнование или загрузите его из файла на экране «Соревнование».</p>
      )}
    </div>
  );
}

function QrCard({ judge }: { judge: IssuedJudge }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    void QRCode.toDataURL(loginUrl(judge.token), { width: 240, margin: 1 }).then(setSrc);
  }, [judge.token]);
  return (
    <figure className="qr">
      {src && <img src={src} alt={`QR-код для ${judge.name}`} />}
      <figcaption>
        <strong>
          {APPARATUS_NAMES[judge.apparatus]} · {judgeLabel(judge.role, judge.seat)}
        </strong>
        <br />
        {judge.name}
      </figcaption>
    </figure>
  );
}

/** Строка судьи в списке: просмотр или правка на месте. */
const ROLE_ORDER: Record<JudgeRole, number> = { SUPERVISOR: 0, D: 1, E: 2 };

/**
 * Судьи по снарядам: карточки в три колонки на компьютере, в две на планшете, в одну на телефоне.
 * Каждый снаряд сворачивается, в заголовке — состав бригады.
 */
function JudgesByApparatus({
  judges,
  discipline,
  renderRow,
}: {
  judges: Judge[];
  discipline: Discipline;
  renderRow: (judge: Judge) => ReactNode;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const groups = apparatusFor(discipline)
    .map((apparatus) => ({
      apparatus,
      panel: judges
        .filter((j) => j.apparatus === apparatus)
        .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.seat - b.seat),
    }))
    .filter((g) => g.panel.length > 0);
  return (
    <div className="panel no-print judges-list">
      {groups.map(({ apparatus, panel }) => (
        <details
          key={apparatus}
          open={!closed.has(apparatus)}
          onToggle={(ev) => {
            const isClosed = !ev.currentTarget.open;
            setClosed((set) => {
              if (set.has(apparatus) === isClosed) return set;
              const next = new Set(set);
              if (isClosed) next.add(apparatus);
              else next.delete(apparatus);
              return next;
            });
          }}
        >
          <summary>
            <strong>{APPARATUS_NAMES[apparatus]}</strong>
            <span className="muted"> · {panel.map((j) => judgeLabel(j.role, j.seat)).join(", ")}</span>
          </summary>
          <table>
            <tbody>{panel.map(renderRow)}</tbody>
          </table>
        </details>
      ))}
    </div>
  );
}

function JudgeRow({
  judge,
  grouped = false,
  discipline,
  onSave,
  onRemove,
  onReissue,
  onCopyLink,
}: {
  judge: Judge;
  /** В списке по снарядам снаряд уже указан в заголовке. */
  grouped?: boolean;
  discipline: Discipline;
  onSave: (changes: Partial<Judge>) => Promise<boolean>;
  onRemove: () => void;
  onReissue: () => void;
  onCopyLink: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    const actions = (
      <>
        <button type="button" className="link" onClick={() => setEditing(true)}>
          Изменить
        </button>
        <button type="button" className="link" onClick={onReissue}>
          Новый QR-код
        </button>
        <button type="button" className="link" onClick={onCopyLink} title="Для судьи за компьютером без камеры">
          Копировать ссылку
        </button>
        <button type="button" className="link danger" onClick={onRemove}>
          Удалить
        </button>
      </>
    );
    return (
      <tr>
        {!grouped && <td>{APPARATUS_NAMES[judge.apparatus]}</td>}
        <td>
          {judgeLabel(judge.role, judge.seat)}
          {judge.enterAllMarks && <span className="muted"> · планшет снаряда</span>}
        </td>
        <td>
          {judge.name}
          {judge.category && <span className="muted"> · {judge.category}</span>}
          {/* В карточке снаряда кнопки идут строкой под ФИО, иначе узкая колонка вытягивает их столбиком. */}
          {grouped && <div className="judge-actions">{actions}</div>}
        </td>
        {!grouped && <td className="judge-actions">{actions}</td>}
      </tr>
    );
  }
  return (
    <tr className="judge-edit">
      <td colSpan={4}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const role = String(form.get("role")) as JudgeRole;
            void onSave({
              name: String(form.get("name")).trim(),
              category: String(form.get("category") ?? "").trim() || null,
              apparatus: String(form.get("apparatus")),
              role,
              seat: Number(form.get("seat")),
              enterAllMarks: role === "SUPERVISOR" && form.get("enterAllMarks") === "on",
            }).then((ok) => ok && setEditing(false));
          }}
        >
          <label>
            ФИО судьи
            <input name="name" defaultValue={judge.name} required />
          </label>
          <label>
            Категория
            <input name="category" list="judge-categories" defaultValue={judge.category ?? ""} />
          </label>
          <label>
            Снаряд
            <select name="apparatus" defaultValue={judge.apparatus}>
              {apparatusFor(discipline).map((a) => (
                <option key={a} value={a}>
                  {APPARATUS_NAMES[a]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Роль
            <select name="role" defaultValue={judge.role}>
              {(Object.keys(ROLE_NAMES) as JudgeRole[]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_NAMES[r]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Место в бригаде
            <input name="seat" type="number" min={1} max={10} defaultValue={judge.seat} required />
          </label>
          <label className="check">
            <input name="enterAllMarks" type="checkbox" defaultChecked={judge.enterAllMarks} />
            Один планшет на снаряд (для старшего судьи)
          </label>
          <div className="buttons">
            <button type="submit" className="primary">
              Сохранить
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Отмена
            </button>
          </div>
          <p className="muted">Если судья уже ставил оценки, менять можно только ФИО и категорию.</p>
        </form>
      </td>
    </tr>
  );
}

const SESSION_CHECK_MS = 60_000;

/**
 * Вход в секретариат: паролем (после 5 ошибок вход с устройства закрывается на 15 минут)
 * или токеном из окна запуска. Здесь же смена пароля и «Выйти на всех устройствах».
 */
function AccessPanel({ adminToken, onToken }: { adminToken: string; onToken: (token: string) => void }) {
  const [secret, setSecret] = useState("");
  const [passwordSet, setPasswordSet] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!adminToken) return;
    let cancelled = false;
    const check = () =>
      apiRequest<{ passwordSet: boolean }>("/auth/session", { token: adminToken })
        .then((r) => !cancelled && setPasswordSet(r.passwordSet))
        .catch((e: ApiError) => {
          if (cancelled || e.status !== 401) return;
          onToken("");
          setMessage("Вход больше не действует: войдите снова.");
        });
    void check();
    const timer = setInterval(() => void check(), SESSION_CHECK_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [adminToken, onToken]);

  const login = async () => {
    setBusy(true);
    try {
      const r = await apiRequest<{ token: string; passwordSet: boolean }>("/auth/login", { method: "POST", body: { secret } });
      setSecret("");
      setPasswordSet(r.passwordSet);
      setMessage(r.passwordSet ? null : "Пароль секретариата ещё не задан. Задайте его в «Пароль и вход», чтобы не носить с собой токен.");
      onToken(r.token);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async (form: HTMLFormElement) => {
    const data = new FormData(form);
    const password = String(data.get("password") ?? "");
    if (password !== String(data.get("repeat") ?? "")) {
      setMessage("Пароли не совпадают.");
      return;
    }
    try {
      const r = await apiRequest<{ token: string }>("/auth/password", { token: adminToken, method: "PUT", body: { password } });
      form.reset();
      setPasswordSet(true);
      setMessage("Пароль сохранён. На других компьютерах и планшетах секретариата нужно войти заново, уже новым паролем.");
      onToken(r.token);
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const logout = async (everywhere: boolean) => {
    if (everywhere && !confirm("Выйти на всех устройствах? Всем компьютерам секретариата придётся войти заново.")) return;
    await apiRequest(everywhere ? "/auth/logout-all" : "/auth/logout", { token: adminToken, method: "POST" }).catch(() => undefined);
    onToken("");
    setMessage(everywhere ? "Все входы в секретариат закрыты. Войдите снова." : null);
  };

  if (!adminToken) {
    return (
      <form
        className="access-login"
        onSubmit={(e) => {
          e.preventDefault();
          void login();
        }}
      >
        <label>
          Пароль секретариата
          {/* Не поле пароля: иначе браузер на общем компьютере секретариата предлагает запомнить пароль. */}
          <input
            className="secret"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            autoFocus
          />
        </label>
        <button type="submit" className="primary" disabled={busy || !secret.trim()}>
          Войти
        </button>
        {message && <p className="warning-text access-message">{message}</p>}
      </form>
    );
  }
  return (
    <div className="access-status">
      <span className="ok-text">Вход выполнен</span>
      <button type="button" onClick={() => void logout(false)}>
        Выйти
      </button>
      <details className="access-settings">
        <summary>Пароль и вход</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void changePassword(e.currentTarget);
          }}
        >
          <p className="muted">
            {passwordSet
              ? "Новый пароль закроет все прежние входы."
              : "Пароль ещё не задан: сейчас войти можно только токеном из окна запуска сервера."}
          </p>
          <label>
            {passwordSet ? "Новый пароль" : "Пароль"}, не короче 8 символов
            <input type="password" name="password" minLength={8} required autoComplete="new-password" />
          </label>
          <label>
            Ещё раз
            <input type="password" name="repeat" minLength={8} required autoComplete="new-password" />
          </label>
          <button type="submit">{passwordSet ? "Сменить пароль" : "Задать пароль"}</button>
        </form>
        <p className="muted">
          Если пароль мог узнать посторонний или забыт компьютер с открытым секретариатом, нажмите кнопку ниже и задайте новый
          пароль.
        </p>
        <button type="button" className="primary danger" onClick={() => void logout(true)}>
          Выйти на всех устройствах
        </button>
      </details>
      {message && <p className="warning-text access-message">{message}</p>}
    </div>
  );
}

interface LicenseStatus {
  state: "active" | "expired" | "missing" | "invalid";
  license: { id: string; org: string; until: string } | null;
  daysLeft: number | null;
  required: boolean;
}

const ruDate = (iso: string) => iso.split("-").reverse().join(".");

/**
 * Лицензия программы: кому выдана и до какого дня. Без действующей лицензии создаются
 * только пробные турниры, уже идущие турниры работают как обычно.
 */
function LicensePanel({ adminToken }: { adminToken: string }) {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    apiRequest<LicenseStatus>("/license", { token: adminToken })
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [adminToken]);

  if (!status || !status.required) return null;
  const active = status.state === "active";
  const soon = active && (status.daysLeft ?? 0) <= 30;

  const save = async () => {
    try {
      const next = await apiRequest<LicenseStatus>("/license", { token: adminToken, method: "PUT", body: { key } });
      setStatus(next);
      setKey("");
      setOpen(false);
      setMessage("Ключ лицензии сохранён.");
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  return (
    <section className={`panel no-print license-panel${active && !soon ? "" : " license-warning"}`}>
      <h2>Лицензия</h2>
      <p className="wide">
        {active && (
          <>
            <strong className={soon ? "warning-text" : "ok-text"}>
              Действует до {ruDate(status.license!.until)} включительно
            </strong>
            {" · "}
            {status.license!.org}
            {soon && ` · осталось дней: ${status.daysLeft}. Продлите лицензию заранее.`}
          </>
        )}
        {status.state === "expired" && (
          <strong className="warning-text">
            Срок лицензии закончился {ruDate(status.license!.until)}. Новые турниры — только пробные; начатые турниры работают
            как обычно.
          </strong>
        )}
        {(status.state === "missing" || status.state === "invalid") && (
          <strong className="warning-text">
            {status.state === "invalid" ? "Ключ лицензии неверный. " : "Лицензия не введена. "}
            Без лицензии можно проводить только пробный турнир для репетиции.
          </strong>
        )}
      </p>
      {active && !open ? (
        <button type="button" className="link" onClick={() => setOpen(true)}>
          Ввести новый ключ
        </button>
      ) : (
        <form
          className="wide license-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            Ключ лицензии
            <textarea value={key} onChange={(e) => setKey(e.target.value)} rows={3} spellCheck={false} placeholder="AG1.…" />
          </label>
          <button type="submit" className="primary" disabled={!key.trim()}>
            Сохранить ключ
          </button>
        </form>
      )}
      {message && <p className="wide muted">{message}</p>}
    </section>
  );
}
