import { useState, useEffect } from "react";
import { Routes, Route } from "react-router-dom";
import Dashboard from "./components/Dashboard";
import ReviewView from "./components/ReviewView";
import FirstRun, { STORE_FILE, WORKSPACE_KEY } from "./components/FirstRun";
import { getToken, setToken, clearToken } from "./lib/api";

// True when running inside the Tauri desktop app
const IS_TAURI = Boolean(
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__,
);

function AuthGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(() => Boolean(getToken()));
  const [input, setInput] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const handler = () => {
      clearToken();
      setAuthed(false);
      setError("Session expired. Please sign in again.");
    };
    window.addEventListener("cvp:unauthorized", handler);
    return () => window.removeEventListener("cvp:unauthorized", handler);
  }, []);

  function submit() {
    const token = input.trim();
    if (!token) return;
    setToken(token);
    setAuthed(true);
    setError("");
    setInput("");
  }

  if (!authed) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: "var(--color-bg)" }}
      >
        <div
          className="w-full max-w-sm p-8 rounded-lg border"
          style={{
            background: "var(--color-surface)",
            borderColor: "var(--color-border)",
          }}
        >
          <h1
            className="text-xl font-bold mb-2"
            style={{ color: "var(--color-text)" }}
          >
            ContentViewPro
          </h1>
          <p
            className="text-sm mb-6"
            style={{ color: "var(--color-text-muted)" }}
          >
            Enter your access token to continue.
          </p>
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Access token"
            autoFocus
            className="w-full rounded p-3 text-sm mb-3 outline-none border"
            style={{
              background: "var(--color-bg)",
              color: "var(--color-text)",
              borderColor: "var(--color-border)",
            }}
          />
          {error && (
            <p
              className="text-xs mb-3"
              style={{ color: "var(--color-revised)" }}
            >
              {error}
            </p>
          )}
          <button
            onClick={submit}
            className="w-full py-2 rounded font-semibold text-sm transition-colors"
            style={{ background: "var(--color-primary)", color: "#fff" }}
          >
            Sign In
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

function WorkspaceGate({ children }: { children: React.ReactNode }) {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!IS_TAURI) {
      setLoading(false);
      return;
    }
    import("@tauri-apps/plugin-store").then(({ Store }) =>
      Store.load(STORE_FILE).then((store) =>
        store.get<string>(WORKSPACE_KEY).then((path) => {
          setWorkspace(path ?? null);
          setLoading(false);
        }),
      ),
    );
  }, []);

  if (loading) return null;
  if (IS_TAURI && !workspace) {
    return <FirstRun onWorkspaceSet={setWorkspace} />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <div className="min-h-screen" style={{ background: "var(--color-bg)" }}>
      <WorkspaceGate>
        {IS_TAURI ? (
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/review/:id" element={<ReviewView />} />
          </Routes>
        ) : (
          <AuthGate>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/review/:id" element={<ReviewView />} />
            </Routes>
          </AuthGate>
        )}
      </WorkspaceGate>
    </div>
  );
}
