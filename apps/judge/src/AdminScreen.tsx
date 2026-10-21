import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { apparatusFor, type Discipline } from "@ag/scoring";
import { JUDGE_CATEGORIES, type JudgeRole, type Official, type Rules } from "@ag/shared";
import { apiRequest } from "./api";
import { APPARATUS_NAMES, ROLE_NAMES, judgeLabel } from "./labels";
import {
  DrawPanel,
  FinalsPanel,
  NormativesPanel,
  ClubStandingPanel,
  CeremonyPanel,
  AuditPanel,
  ShiftsPanel,
  ManualScoresPanel,
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

/** Секретариат: судьи и их QR-коды, протоколы, запросы тренеров на пересмотр D. */
export function AdminScreen() {
  const [adminToken, setAdminToken] = useState(() => sessionStorage.getItem(ADMIN_KEY) ?? "");
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [competitionId, setCompetitionId] = useState("");
  const [judges, setJudges] = useState<Judge[]>([]);
  const [newRole, setNewRole] = useState<JudgeRole>("D");
  const [newSingle, setNewSingle] = useState(false);
  const [issued, setIssued] = useState<IssuedJudge[]>([]);
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

  const remember = (token: string) => {
    setAdminToken(token);
    sessionStorage.setItem(ADMIN_KEY, token);
  };

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

  const reissue = async (judge: Judge) => {
    if (!confirm(`Выдать ${judge.name} новый QR-код? Старый перестанет работать.`)) return;
    try {
      const fresh = await apiRequest<IssuedJudge>(`/judges/${judge.id}/token`, { token: adminToken, method: "POST" });
      setIssued((list) => [...list.filter((j) => j.id !== judge.id), fresh]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveJudge = async (judge: Judge, changes: Partial<Judge>) => {
    try {
      const saved = await apiRequest<Judge>(`/judges/${judge.id}`, { token: adminToken, method: "PATCH", body: changes });
      setIssued((list) => list.map((j) => (j.id === saved.id ? { ...j, ...saved } : j)));
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
        <label>
          Токен секретариата
          {/* Не поле пароля: иначе браузер при каждом сохранении оценки предлагает запомнить «пароль». */}
          <input
            className="secret"
            value={adminToken}
            onChange={(e) => remember(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
          />
        </label>
        <label>
          Соревнование
          <select value={listedId} onChange={(e) => setCompetitionId(e.target.value)}>
            {listed.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({competitions.some((o) => o.pairId && o.pairId === c.pairId && o.id !== c.id) ? "девочки и мальчики" : c.discipline})
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

      {error && <div className="alert no-print">{error}</div>}
      {!adminToken && <div className="alert no-print">Введите токен секретариата: он показан в окне запуска сервера.</div>}

      <div {...pane("competition")}>
        {adminToken && (
          <details className="no-print new-competition" open={competitions.length === 0}>
            <summary>Новое соревнование</summary>
            <NewCompetitionForm
              adminToken={adminToken}
              onError={setError}
              onCreated={(id) => {
                setIssued([]);
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
                void loadCompetitions(id);
              }}
            />
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
              adminToken={adminToken}
              onError={setError}
              onDeleted={() => {
                setIssued([]);
                setCompetitionId("");
                void loadCompetitions();
              }}
            />
          </>
        )}
        {adminToken && (
          <SeriesPanel key={`series-${competitions.length}`} competitions={competitions} adminToken={adminToken} onError={setError} />
        )}
      </div>

      {ready && competition && (
        <>
          <div {...pane("roster")}>
            <OnlineEntriesPanel
              key={`online-${competition.id}`}
              competitionId={competition.id}
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
              <table className="panel no-print">
                <tbody>
                  {judges.map((j) => (
                    <JudgeRow
                      key={j.id}
                      judge={j}
                      discipline={competition.discipline}
                      onSave={(changes) => saveJudge(j, changes)}
                      onRemove={() => void removeJudge(j)}
                      onReissue={() => void reissue(j)}
                    />
                  ))}
                </tbody>
              </table>
            )}

            {issued.length > 0 && (
              <>
                <div className="no-print">
                  <button type="button" className="primary" onClick={() => print()}>
                    Печать QR-кодов
                  </button>
                  <p className="muted">Код показывается один раз. Если планшет потерян, выдайте новый код.</p>
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
            />
            <ProgressPanel
              key={`progress-${competition.id}`}
              competitionId={competition.id}
              discipline={competition.discipline}
              active={tab === "progress"}
              onError={setError}
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
function JudgeRow({
  judge,
  discipline,
  onSave,
  onRemove,
  onReissue,
}: {
  judge: Judge;
  discipline: Discipline;
  onSave: (changes: Partial<Judge>) => Promise<boolean>;
  onRemove: () => void;
  onReissue: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <tr>
        <td>{APPARATUS_NAMES[judge.apparatus]}</td>
        <td>
          {judgeLabel(judge.role, judge.seat)}
          {judge.enterAllMarks && <span className="muted"> · планшет снаряда</span>}
        </td>
        <td>
          {judge.name}
          {judge.category && <span className="muted"> · {judge.category}</span>}
        </td>
        <td className="judge-actions">
          <button type="button" className="link" onClick={() => setEditing(true)}>
            Изменить
          </button>
          <button type="button" className="link" onClick={onReissue}>
            Новый QR-код
          </button>
          <button type="button" className="link danger" onClick={onRemove}>
            Удалить
          </button>
        </td>
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
