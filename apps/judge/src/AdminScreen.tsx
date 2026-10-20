import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { apparatusFor, type Discipline } from "@ag/scoring";
import type { JudgeRole, Rules } from "@ag/shared";
import { apiRequest } from "./api";
import { APPARATUS_NAMES, ROLE_NAMES, judgeLabel } from "./labels";
import {
  DrawPanel,
  FinalsPanel,
  InquiriesPanel,
  NewCompetitionForm,
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
}

interface Judge {
  id: string;
  name: string;
  apparatus: string;
  role: JudgeRole;
  seat: number;
  /** Планшет снаряда: старший судья вводит оценки всей бригады. */
  enterAllMarks: boolean;
}

interface IssuedJudge extends Judge {
  token: string;
}

const ADMIN_KEY = "admin-token";

function loginUrl(token: string): string {
  return `${location.origin}/judge/#token=${encodeURIComponent(token)}`;
}

/** Секретариат: судьи и их QR-коды, протоколы, запросы тренеров на пересмотр D. */
export function AdminScreen() {
  const [adminToken, setAdminToken] = useState(() => sessionStorage.getItem(ADMIN_KEY) ?? "");
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [competitionId, setCompetitionId] = useState("");
  const [judges, setJudges] = useState<Judge[]>([]);
  const [issued, setIssued] = useState<IssuedJudge[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Растёт после загрузки участников: в правилах появляются новые разряды.
  const [rosterVersion, setRosterVersion] = useState(0);
  // Растёт после жеребьёвки: списку участников и сменам нужны новые номера.
  const [drawVersion, setDrawVersion] = useState(0);

  const competition = competitions.find((c) => c.id === competitionId);

  const loadCompetitions = useCallback(async (select?: string) => {
    try {
      const list = await apiRequest<Competition[]>("/competitions");
      setCompetitions(list);
      if (select) setCompetitionId(select);
      else if (list.length > 0) setCompetitionId((id) => id || list.at(-1)!.id);
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

  const remember = (token: string) => {
    setAdminToken(token);
    sessionStorage.setItem(ADMIN_KEY, token);
  };

  const addJudge = async (form: FormData) => {
    try {
      const judge = await apiRequest<IssuedJudge>(`/competitions/${competitionId}/judges`, {
        token: adminToken,
        method: "POST",
        body: {
          name: String(form.get("name")),
          apparatus: String(form.get("apparatus")),
          role: String(form.get("role")),
          seat: Number(form.get("seat")),
          enterAllMarks: form.get("enterAllMarks") === "on",
        },
      });
      // Если на снаряде один планшет, судьям D и E QR-коды не нужны: оценки за них вводит старший.
      const tabletApparatus = new Set(
        [...judges, judge].filter((j) => j.enterAllMarks).map((j) => j.apparatus),
      );
      setIssued((list) =>
        [...list, judge].filter((j) => j.role === "SUPERVISOR" || !tabletApparatus.has(j.apparatus)),
      );
      await loadJudges();
    } catch (e) {
      setError((e as Error).message);
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

  return (
    <div className="screen admin">
      <header className="bar no-print">
        <div className="apparatus">Секретариат</div>
      </header>
      <section className="panel no-print">
        <label>
          Токен секретариата
          <input type="password" value={adminToken} onChange={(e) => remember(e.target.value)} />
        </label>
        <label>
          Соревнование
          <select value={competitionId} onChange={(e) => setCompetitionId(e.target.value)}>
            {competitions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.discipline})
              </option>
            ))}
          </select>
        </label>
      </section>

      {error && <div className="alert no-print">{error}</div>}

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

      {competition && adminToken && (
        <RosterPanel
          key={`${competition.id}-${drawVersion}`}
          competitionId={competition.id}
          teamFormat={{
            roster: competition.teamRoster,
            perApparatus: competition.teamPerApparatus,
            counting: competition.teamCounting,
          }}
          adminToken={adminToken}
          onError={setError}
          onImported={() => setRosterVersion((v) => v + 1)}
        />
      )}

      {competition && adminToken && (
        <RulesPanel
          key={`rules-${competition.id}-${rosterVersion}`}
          competitionId={competition.id}
          discipline={competition.discipline}
          adminToken={adminToken}
          onError={setError}
          onSaved={() => void loadCompetitions(competition.id)}
        />
      )}

      {competition && adminToken && (
        <DrawPanel
          key={`draw-${competition.id}-${rosterVersion}`}
          competitionId={competition.id}
          adminToken={adminToken}
          onError={setError}
          onDrawn={() => setDrawVersion((v) => v + 1)}
        />
      )}

      {competition && adminToken && (
        <RotationPanel
          key={`rotation-${competition.id}-${drawVersion}`}
          competitionId={competition.id}
          discipline={competition.discipline}
          adminToken={adminToken}
          onError={setError}
        />
      )}

      {competition && adminToken && (
        <form
          className="panel no-print"
          onSubmit={(e) => {
            e.preventDefault();
            void addJudge(new FormData(e.currentTarget));
            e.currentTarget.reset();
          }}
        >
          <h2>Судьи и QR-коды</h2>
          <label>
            ФИО судьи
            <input name="name" required />
          </label>
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
            <select name="role">
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
          <label className="check wide">
            <input name="enterAllMarks" type="checkbox" />
            Один планшет на снаряд: старший судья вводит оценки всей бригады (судьям D и E QR-коды не нужны)
          </label>
          <button type="submit" className="primary">
            Добавить судью
          </button>
        </form>
      )}

      {judges.length > 0 && (
        <table className="panel no-print">
          <tbody>
            {judges.map((j) => (
              <tr key={j.id}>
                <td>{APPARATUS_NAMES[j.apparatus]}</td>
                <td>
                  {judgeLabel(j.role, j.seat)}
                  {j.enterAllMarks && <span className="muted"> · планшет снаряда</span>}
                </td>
                <td>{j.name}</td>
                <td>
                  <button type="button" className="link" onClick={() => void reissue(j)}>
                    Новый QR-код
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {competition && adminToken && (
        <>
          <ProtocolsPanel
            competitionId={competition.id}
            discipline={competition.discipline}
            adminToken={adminToken}
            onError={setError}
          />
          <FinalsPanel key={`finals-${competition.id}`} competitionId={competition.id} adminToken={adminToken} onError={setError} />
          <InquiriesPanel
            key={competition.id}
            competitionId={competition.id}
            discipline={competition.discipline}
            rules={competition.rules}
            adminToken={adminToken}
            onError={setError}
          />
        </>
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
