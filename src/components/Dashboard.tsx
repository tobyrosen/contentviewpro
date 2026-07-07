import { useEffect, useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import type { UnwatchFn } from "@tauri-apps/plugin-fs";
import { fetchArticles, type ArticleSummary } from "../lib/api";

const IS_TAURI = Boolean(
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__,
);

export default function Dashboard() {
  const [articles, setArticles] = useState<ArticleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const refresh = useCallback(() => {
    fetchArticles().then(setArticles);
  }, []);

  useEffect(() => {
    fetchArticles()
      .then(setArticles)
      .finally(() => setLoading(false));
  }, []);

  // Watch drafts dir in Tauri and auto-refresh on file changes
  useEffect(() => {
    if (!IS_TAURI) return;
    let unwatch: UnwatchFn | undefined;
    let debounce: ReturnType<typeof setTimeout>;

    (async () => {
      const [{ Store }, { watch }] = await Promise.all([
        import("@tauri-apps/plugin-store"),
        import("@tauri-apps/plugin-fs"),
      ]);
      const store = await Store.load("settings.json");
      const workspace = await store.get<string>("workspacePath");
      if (!workspace) return;

      unwatch = await watch(
        `${workspace}/drafts`,
        () => {
          clearTimeout(debounce);
          debounce = setTimeout(refresh, 300);
        },
        { recursive: false },
      );
    })();

    return () => {
      clearTimeout(debounce);
      unwatch?.();
    };
  }, [refresh]);

  const [lanUrl, setLanUrl] = useState<string | null>(null);
  const [lanBusy, setLanBusy] = useState(false);
  const LAN_PORT = 3034;

  useEffect(() => {
    if (!IS_TAURI) return;
    invoke<string | null>("get_lan_status")
      .then(setLanUrl)
      .catch(() => {});
  }, []);

  async function toggleLan() {
    setLanBusy(true);
    try {
      if (lanUrl) {
        await invoke("stop_lan_server");
        setLanUrl(null);
      } else {
        const url = await invoke<string>("start_lan_server", {
          port: LAN_PORT,
        });
        setLanUrl(url);
      }
    } finally {
      setLanBusy(false);
    }
  }

  const pending = articles.filter((a) => !a.submitted);
  const submitted = articles.filter((a) => a.submitted);

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <div className="flex items-start justify-between mb-2">
        <h1
          className="text-3xl font-bold"
          style={{ color: "var(--color-text)" }}
        >
          ContentViewPro
        </h1>
        {IS_TAURI && (
          <div className="flex items-center gap-3 mt-1">
            {lanUrl && (
              <span
                className="text-xs font-mono"
                style={{ color: "var(--color-text-muted)" }}
              >
                {lanUrl}
              </span>
            )}
            <button
              onClick={toggleLan}
              disabled={lanBusy}
              className="px-3 py-1 rounded text-xs font-medium transition-colors disabled:opacity-40"
              style={{
                background: lanUrl
                  ? "var(--color-border)"
                  : "var(--color-surface)",
                color: lanUrl
                  ? "var(--color-revised)"
                  : "var(--color-text-muted)",
                border: `1px solid var(--color-border)`,
              }}
            >
              {lanBusy ? "..." : lanUrl ? "Stop LAN" : "LAN"}
            </button>
          </div>
        )}
      </div>
      <p className="mb-8" style={{ color: "var(--color-text-muted)" }}>
        Paragraph-by-paragraph content review
      </p>

      {loading ? (
        <p style={{ color: "var(--color-text-muted)" }}>Loading...</p>
      ) : articles.length === 0 ? (
        <div
          className="rounded-lg border p-8 text-center"
          style={{
            background: "var(--color-surface)",
            borderColor: "var(--color-border)",
          }}
        >
          <p style={{ color: "var(--color-text-muted)" }}>
            No drafts yet. Drop markdown files into the drafts/ folder.
          </p>
        </div>
      ) : (
        <>
          {pending.length > 0 && (
            <section className="mb-10">
              <h2
                className="text-lg font-semibold mb-4"
                style={{ color: "var(--color-text)" }}
              >
                Pending Review ({pending.length})
              </h2>
              <div className="grid gap-3">
                {pending.map((article) => (
                  <ArticleCard
                    key={article.id}
                    article={article}
                    onClick={() => navigate(`/review/${article.id}`)}
                  />
                ))}
              </div>
            </section>
          )}

          {submitted.length > 0 && (
            <section>
              <h2
                className="text-lg font-semibold mb-4"
                style={{ color: "var(--color-text-muted)" }}
              >
                Submitted ({submitted.length})
              </h2>
              <div className="grid gap-3 opacity-60">
                {submitted.map((article) => (
                  <ArticleCard
                    key={article.id}
                    article={article}
                    onClick={() => navigate(`/review/${article.id}`)}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ArticleCard({
  article,
  onClick,
}: {
  article: ArticleSummary;
  onClick: () => void;
}) {
  const progress =
    article.total > 0 ? (article.reviewed / article.total) * 100 : 0;

  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-lg border p-5 transition-colors cursor-pointer"
      style={{
        background: "var(--color-surface)",
        borderColor: "var(--color-border)",
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = "var(--color-surface-hover)")
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.background = "var(--color-surface)")
      }
    >
      <div className="flex items-start justify-between mb-2">
        <h3
          className="font-semibold text-base"
          style={{ color: "var(--color-text)" }}
        >
          {article.title}
        </h3>
        {article.submitted && (
          <span
            className="text-xs font-medium px-2 py-0.5 rounded"
            style={{
              background: "var(--color-approved)",
              color: "#000",
            }}
          >
            Submitted
          </span>
        )}
      </div>

      <div
        className="flex gap-4 text-sm mb-3"
        style={{ color: "var(--color-text-muted)" }}
      >
        {article.client && <span>{article.client}</span>}
        {article.type && <span>{article.type}</span>}
        {article.round > 1 && <span>Round {article.round}</span>}
      </div>

      <div className="flex items-center gap-3">
        <div
          className="flex-1 h-1.5 rounded-full overflow-hidden"
          style={{ background: "var(--color-border)" }}
        >
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${progress}%`,
              background:
                progress === 100
                  ? "var(--color-approved)"
                  : "var(--color-primary)",
            }}
          />
        </div>
        <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
          {article.reviewed}/{article.total}
        </span>
      </div>
    </button>
  );
}
