import { useEffect, useState } from "react";
import { ApiError, apiRequest } from "./api";
import { AdminScreen } from "./AdminScreen";
import { JudgeScreen } from "./JudgeScreen";
import { forgetToken, takeTokenFromLocation } from "./token";

type Me = Parameters<typeof JudgeScreen>[0]["me"];

export function App() {
  if (location.hash.startsWith("#/admin")) return <AdminScreen />;
  return <JudgeApp />;
}

function JudgeApp() {
  const [token, setToken] = useState(() => takeTokenFromLocation(location, localStorage));
  const [me, setMe] = useState<Me | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const load = () =>
      apiRequest<Me>("/me", { token })
        .then((data) => !cancelled && setMe(data))
        .catch((e: ApiError) => {
          if (cancelled) return;
          if (e.status === 401) {
            forgetToken(localStorage);
            setToken(null);
            setProblem("Код входа больше не действует. Попросите в секретариате новый QR-код.");
          } else {
            setProblem(e.message);
            setTimeout(load, 3000);
          }
        });
    load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) {
    return (
      <div className="screen waiting">
        <h1>Вход судьи</h1>
        <p>Отсканируйте QR-код, который выдал секретариат.</p>
        {problem && <div className="alert">{problem}</div>}
      </div>
    );
  }
  if (!me) {
    return <div className="screen waiting">{problem ?? "Подключаемся к серверу…"}</div>;
  }
  return (
    <JudgeScreen
      token={token}
      me={me}
      onLogout={() => {
        if (!confirm("Выйти? Для входа снова понадобится QR-код.")) return;
        forgetToken(localStorage);
        setToken(null);
        setMe(null);
      }}
    />
  );
}
