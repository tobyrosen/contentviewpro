import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  fetchPatterns,
  fetchVoiceSpec,
  type PatternsResponse,
  type RankedPattern,
} from "../lib/api";

function humanize(key: string): string {
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function truncate(text: string, max = 220): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

// Generic intent renderer: takes whatever {label: count} map the miner provides
// (2-way notes/rewrites or the 6-way edit-intent counts) and shows proportion
// bars sorted by frequency. `size="lg"` is used for the headline block.
function IntentBars({
  data,
  size = "sm",
}: {
  data: Record<string, number>;
  size?: "sm" | "lg";
}) {
  const entries = Object.entries(data).filter(
    ([, v]) => typeof v === "number" && Number.isFinite(v),
  );
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, v]) => sum + v, 0) || 1;
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);
  const lg = size === "lg";

  return (
    <div className="flex flex-col gap-2">
      {sorted.map(([key, val]) => {
        const pct = Math.round((val / total) * 100);
        return (
          <div key={key} className="flex items-center gap-3">
            <span
              className={`${lg ? "text-base w-44" : "text-sm w-40"} shrink-0`}
              style={{ color: "var(--color-text)" }}
            >
              {humanize(key)}
            </span>
            <div
              className={`flex-1 ${lg ? "h-3" : "h-2"} rounded-full overflow-hidden`}
              style={{ background: "var(--color-border)" }}
            >
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${pct}%`, background: "var(--color-primary)" }}
              />
            </div>
            <span
              className={`${lg ? "text-sm w-24" : "text-xs w-20"} text-right tabular-nums`}
              style={{ color: "var(--color-text-muted)" }}
            >
              {val} · {pct}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

function PatternCard({
  pattern,
  rank,
  maxCount,
  totalRevised,
}: {
  pattern: RankedPattern;
  rank: number;
  maxCount: number;
  totalRevised: number | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const barPct = maxCount > 0 ? (pattern.count / maxCount) * 100 : 0;
  const sharePct =
    totalRevised && totalRevised > 0
      ? Math.round((pattern.count / totalRevised) * 100)
      : null;
  const examples = expanded ? pattern.examples : pattern.examples.slice(0, 2);
  const hasNoteRewrite =
    pattern.note_rewrite && Object.keys(pattern.note_rewrite).length > 0;

  return (
    <div
      className="rounded-lg border p-5"
      style={{
        background: "var(--color-surface)",
        borderColor: "var(--color-border)",
      }}
    >
      <div className="flex items-baseline gap-3 mb-2">
        <span
          className="text-sm font-mono shrink-0"
          style={{ color: "var(--color-text-muted)" }}
        >
          #{rank}
        </span>
        <h3
          className="font-semibold text-base flex-1"
          style={{ color: "var(--color-text)" }}
        >
          {pattern.name}
        </h3>
        <span
          className="text-sm font-semibold tabular-nums shrink-0"
          style={{ color: "var(--color-text)" }}
        >
          {pattern.count}
          {sharePct !== null && (
            <span
              className="font-normal ml-1"
              style={{ color: "var(--color-text-muted)" }}
            >
              · {sharePct}%
            </span>
          )}
        </span>
      </div>

      {/* Count bar, relative to the top pattern */}
      <div
        className="h-1.5 rounded-full overflow-hidden mb-4"
        style={{ background: "var(--color-border)" }}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${barPct}%`, background: "var(--color-primary)" }}
        />
      </div>

      {hasNoteRewrite && (
        <div className="mb-4">
          <p
            className="text-xs font-medium uppercase tracking-wide mb-2"
            style={{ color: "var(--color-text-muted)" }}
          >
            Notes vs rewrites
          </p>
          <IntentBars data={pattern.note_rewrite!} />
        </div>
      )}

      {examples.length > 0 && (
        <div className="flex flex-col gap-3">
          {examples.map((ex, i) => (
            <div
              key={`${ex.source}-${ex.index}-${i}`}
              className="rounded border p-3"
              style={{
                background: "var(--color-bg)",
                borderColor: "var(--color-border)",
              }}
            >
              <p
                className="text-xs font-mono mb-1.5"
                style={{ color: "var(--color-text-muted)" }}
              >
                {ex.source} · ¶{ex.index}
              </p>
              <p
                className="text-sm mb-2 leading-relaxed"
                style={{ color: "var(--color-text)" }}
              >
                {truncate(ex.original)}
              </p>
              {ex.notes && (
                <p
                  className="text-sm leading-relaxed"
                  style={{ color: "var(--color-revised)" }}
                >
                  &rarr; {ex.notes.trim()}
                </p>
              )}
            </div>
          ))}
          {pattern.examples.length > 2 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-xs font-medium self-start transition-colors"
              style={{ color: "var(--color-primary)" }}
            >
              {expanded
                ? "Show fewer"
                : `Show ${pattern.examples.length - 2} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function Insights() {
  const [data, setData] = useState<PatternsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetchPatterns()
      .then(setData)
      .catch(() =>
        setError(
          "Failed to load edit patterns. Check your report configuration and server connection.",
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    try {
      const md = await fetchVoiceSpec();
      const blob = new Blob([md], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "cvp-voice-spec.md";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportError("Export failed.");
    } finally {
      setExporting(false);
    }
  }

  const maxCount =
    data?.patterns.reduce((m, p) => Math.max(m, p.count), 0) ?? 0;
  const runDate = data?.run_ts ? data.run_ts.slice(0, 10) : null;
  const hasNoteVsRewrite =
    data?.note_vs_rewrite && Object.keys(data.note_vs_rewrite).length > 0;
  const hasIntentBreakdown =
    data?.intent_breakdown && Object.keys(data.intent_breakdown).length > 0;

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => navigate("/")}
          className="text-sm transition-colors"
          style={{ color: "var(--color-text-muted)" }}
        >
          &larr; Dashboard
        </button>
        <button
          onClick={handleExport}
          disabled={exporting || loading || !!error}
          className="px-3 py-1.5 rounded text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: "var(--color-primary)", color: "#fff" }}
        >
          {exporting ? "Exporting..." : "Export voice spec"}
        </button>
      </div>

      <h1 className="text-3xl font-bold" style={{ color: "var(--color-text)" }}>
        Top Recurring Edits
      </h1>
      <p className="mb-2" style={{ color: "var(--color-text-muted)" }}>
        How the reviewer&apos;s edits cluster, ranked by frequency. The drafting
        voice spec is generated from these.
      </p>
      {exportError && (
        <p className="text-sm mb-2" style={{ color: "var(--color-revised)" }}>
          {exportError}
        </p>
      )}

      {loading ? (
        <p className="mt-6" style={{ color: "var(--color-text-muted)" }}>
          Loading...
        </p>
      ) : error ? (
        <div
          className="mt-6 rounded-lg border p-8 text-center"
          style={{
            background: "var(--color-surface)",
            borderColor: "var(--color-border)",
          }}
        >
          <p style={{ color: "var(--color-text-muted)" }}>{error}</p>
        </div>
      ) : data ? (
        <>
          {/* Run summary */}
          <div
            className="flex flex-wrap gap-x-5 gap-y-1 text-sm mt-4 mb-8"
            style={{ color: "var(--color-text-muted)" }}
          >
            {data.total_files !== null && <span>{data.total_files} files</span>}
            {data.total_paragraphs !== null && (
              <span>{data.total_paragraphs.toLocaleString()} paragraphs</span>
            )}
            {data.total_revised !== null && (
              <span>{data.total_revised} revised</span>
            )}
            {runDate && <span>Run {runDate}</span>}
          </div>

          {/* Headline: notes vs rewrites */}
          {hasNoteVsRewrite && (
            <section
              className="rounded-lg border p-5 mb-6"
              style={{
                background: "var(--color-surface)",
                borderColor: "var(--color-border)",
              }}
            >
              <h2
                className="text-lg font-semibold mb-1"
                style={{ color: "var(--color-text)" }}
              >
                Notes vs Rewrites
              </h2>
              <p
                className="text-sm mb-4"
                style={{ color: "var(--color-text-muted)" }}
              >
                How often the reviewer left a note or instruction vs rewrote the text.
              </p>
              <IntentBars data={data.note_vs_rewrite!} size="lg" />
            </section>
          )}

          {/* Full 6-way edit-intent breakdown */}
          {hasIntentBreakdown && (
            <section
              className="rounded-lg border p-5 mb-8"
              style={{
                background: "var(--color-surface)",
                borderColor: "var(--color-border)",
              }}
            >
              <h2
                className="text-lg font-semibold mb-4"
                style={{ color: "var(--color-text)" }}
              >
                Edit intent breakdown
              </h2>
              <IntentBars data={data.intent_breakdown!} />
            </section>
          )}

          {data.patterns.length === 0 ? (
            <div
              className="rounded-lg border p-8 text-center"
              style={{
                background: "var(--color-surface)",
                borderColor: "var(--color-border)",
              }}
            >
              <p style={{ color: "var(--color-text-muted)" }}>
                No edit patterns in the latest run.
              </p>
            </div>
          ) : (
            <div className="grid gap-3">
              {data.patterns.map((pattern, i) => (
                <PatternCard
                  key={pattern.id}
                  pattern={pattern}
                  rank={i + 1}
                  maxCount={maxCount}
                  totalRevised={data.total_revised}
                />
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
