import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs/promises";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { watch } from "chokidar";
import matter from "gray-matter";
import { requireApiToken, tokenMatches, isLoopback, secureDirectory, readContained, readOptional, writeContained, requireRelative, secureRoot } from "./security.js";

const PORT = parseInt(process.env.PORT || "3033", 10);
// Bind loopback by default. The frontend reaches the
// API through Vite's same-machine localhost /api proxy, so it never needs the LAN.
const HOST = process.env.HOST || "127.0.0.1";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:5173";
const CVP_TOKEN = process.env.CVP_TOKEN || "";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(ROOT, process.env.CVP_DATA_DIR || ".");
const DRAFTS_DIR = path.join(DATA_DIR, "drafts");
const REVIEWS_DIR = path.join(DATA_DIR, "reviews");
const STATE_DIR = path.join(DATA_DIR, "state");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
await secureRoot(DATA_DIR);
for (const dir of ["drafts", "reviews", "state"]) await secureDirectory(DATA_DIR, dir, true);

// Optional local Insights data. The private config is deliberately absent from
// the public mirror; without it, review of local drafts still works normally.
const insightsConfigPath = path.join(ROOT, "private", "insights.json");
const insightsConfig: { minerRunsDir?: string; voiceSpecPath?: string } =
  existsSync(insightsConfigPath)
    ? JSON.parse(readFileSync(insightsConfigPath, "utf-8"))
    : {};
const MINER_RUNS_DIR = process.env.CVP_MINER_DIR || insightsConfig.minerRunsDir || "";
const VOICE_SPEC_PATH = process.env.CVP_VOICE_SPEC || insightsConfig.voiceSpecPath || "";
const INSIGHTS_ROOT = process.env.CVP_INSIGHTS_ROOT || "";
const insightsConfigured = Boolean(MINER_RUNS_DIR || VOICE_SPEC_PATH);
requireApiToken(HOST, insightsConfigured, CVP_TOKEN);
if (insightsConfigured) {
  if (!INSIGHTS_ROOT) throw new Error("CVP_INSIGHTS_ROOT is required for Insights");
  if (!path.isAbsolute(INSIGHTS_ROOT)) throw new Error("CVP_INSIGHTS_ROOT must be absolute");
  await secureRoot(INSIGHTS_ROOT);
  if (MINER_RUNS_DIR) requireRelative(MINER_RUNS_DIR);
  if (VOICE_SPEC_PATH) requireRelative(VOICE_SPEC_PATH, ".md");
}

interface Paragraph {
  index: number;
  text: string;
}

interface ParagraphState {
  index: number;
  original: string;
  status: "pending" | "approved" | "revised";
  notes: string | null;
}

interface ArticleMeta {
  id: string;
  filename: string;
  title: string;
  client: string;
  type: string;
  date: string;
  round: number;
}

interface ReviewState {
  articleId: string;
  paragraphs: ParagraphState[];
  order: number[];
  submitted: boolean;
}

function filenameToId(filename: string): string {
  return filename.replace(/\.md$/, "");
}

function validateId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

function parseDraft(content: string): {
  meta: Record<string, any>;
  paragraphs: Paragraph[];
} {
  const { data, content: body } = matter(content);
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((text, index) => ({ index, text }));
  return { meta: data, paragraphs };
}

function isValidReviewState(body: unknown): body is ReviewState {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    Array.isArray(b.paragraphs) &&
    Array.isArray(b.order) &&
    typeof b.submitted === "boolean"
  );
}

async function getArticles(): Promise<ArticleMeta[]> {
  await secureDirectory(DATA_DIR, "drafts");
  const files = await fs.readdir(DRAFTS_DIR);
  const mdFiles = files.filter((f) => f.endsWith(".md") && validateId(filenameToId(f)));
  const articles: ArticleMeta[] = [];

  for (const filename of mdFiles) {
    const content = await readContained(DATA_DIR, `drafts/${filename}`, [".md"]);
    const { meta } = parseDraft(content);
    articles.push({
      id: filenameToId(filename),
      filename,
      title: meta.title || filename,
      client: meta.client || "",
      type: meta.type || "",
      date: meta.date || "",
      round: meta.round || 1,
    });
  }
  return articles;
}

async function getState(articleId: string): Promise<ReviewState | null> {
  const raw = await readOptional(DATA_DIR, `state/${articleId}.json`, [".json"]);
  if (raw === null) return null;
  return JSON.parse(raw);
}

async function saveState(articleId: string, state: ReviewState): Promise<void> {
  await writeContained(DATA_DIR, `state/${articleId}.json`, JSON.stringify(state, null, 2));
}

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.use(express.json());

// The token is required for any exposed or Insights-enabled API.
app.use("/api", (req, res, next) => {
  if (!CVP_TOKEN && !insightsConfigured && isLoopback(HOST)) {
    next();
    return;
  }
  const auth = req.headers.authorization;
  if (!tokenMatches(auth, CVP_TOKEN)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

// Serve built client in production
const distPath = path.join(ROOT, "dist");
if (existsSync(distPath)) {
  app.use(express.static(distPath));
}

app.get("/api/articles", async (_req, res) => {
  try {
    const articles = await getArticles();
    const enriched = await Promise.all(
      articles.map(async (article) => {
        const state = await getState(article.id);
        const content = await readContained(DATA_DIR, `drafts/${article.filename}`, [".md"]);
        const { paragraphs } = parseDraft(content);
        const total = paragraphs.length;
        const reviewed = state
          ? state.paragraphs.filter((p) => p.status !== "pending").length
          : 0;
        return {
          ...article,
          total,
          reviewed,
          submitted: state?.submitted || false,
        };
      }),
    );
    res.json(enriched);
  } catch (err) {
    console.error("GET /api/articles", err);
    res.status(500).json({ error: "Failed to load articles" });
  }
});

app.get("/api/articles/:id", async (req, res) => {
  const { id } = req.params;
  if (!validateId(id)) {
    res.status(400).json({ error: "Invalid article ID" });
    return;
  }

  try {
    const filename = `${id}.md`;
    const content = await readOptional(DATA_DIR, `drafts/${filename}`, [".md"]);
    if (content === null) {
      res.status(404).json({ error: "Article not found" });
      return;
    }

    const { meta, paragraphs } = parseDraft(content);

    let state = await getState(id);
    if (!state) {
      state = {
        articleId: id,
        paragraphs: paragraphs.map((p) => ({
          index: p.index,
          original: p.text,
          status: "pending",
          notes: null,
        })),
        order: paragraphs.map((p) => p.index),
        submitted: false,
      };
      await saveState(id, state);
    }

    res.json({ id, filename, meta, paragraphs, state });
  } catch (err) {
    console.error("GET /api/articles/:id", err);
    res.status(500).json({ error: "Failed to load article" });
  }
});

app.put("/api/articles/:id/state", async (req, res) => {
  const { id } = req.params;
  if (!validateId(id)) {
    res.status(400).json({ error: "Invalid article ID" });
    return;
  }
  if (!isValidReviewState(req.body)) {
    res.status(400).json({ error: "Invalid review state" });
    return;
  }

  try {
    const state: ReviewState = { ...req.body, articleId: id };
    await saveState(id, state);
    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /api/articles/:id/state", err);
    res.status(500).json({ error: "Failed to save state" });
  }
});

app.post("/api/articles/:id/submit", async (req, res) => {
  const { id } = req.params;
  if (!validateId(id)) {
    res.status(400).json({ error: "Invalid article ID" });
    return;
  }

  try {
    const state = await getState(id);
    if (!state) {
      res.status(404).json({ error: "No review state found" });
      return;
    }

    if (state.submitted) {
      res.status(409).json({ error: "Already submitted" });
      return;
    }

    // Enforce: approved paragraphs must have notes: null
    const paragraphs = state.paragraphs.map((p) =>
      p.status === "approved" ? { ...p, notes: null } : p,
    );
    state.submitted = true;
    state.paragraphs = paragraphs;
    await saveState(id, state);

    const review: Record<string, unknown> = {
      source: `${id}.md`,
      reviewedAt: new Date().toISOString(),
      round: 1,
      paragraphs: state.paragraphs,
      order: state.order,
    };

    const content = await readOptional(DATA_DIR, `drafts/${id}.md`, [".md"]);
    if (content !== null) {
      const { meta } = parseDraft(content);
      if (meta.round) review.round = meta.round;
    }

    await writeContained(DATA_DIR, `reviews/${id}.json`, JSON.stringify(review, null, 2));
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/articles/:id/submit", err);
    res.status(500).json({ error: "Failed to submit review" });
  }
});

// --- CVP Insights: top recurring edits + voice spec --------------------------
// Surfaces the latest configured run report (ranked edit patterns) and the
// generated voice spec. Read-only: the miner owns these files.

interface PatternExample {
  source: string;
  index: number;
  original: string;
  notes: string | null;
}

interface RankedPattern {
  id: string;
  name: string;
  count: number;
  examples: PatternExample[];
  // Per-pattern notes-vs-rewrites split (from the run report's top-level
  // pattern_note_rewrite map). Present once the miner tags edit intent.
  note_rewrite?: Record<string, number>;
}

async function findLatestRunReport(): Promise<string | null> {
  if (!MINER_RUNS_DIR) return null;
  const dir = await secureDirectory(INSIGHTS_ROOT, MINER_RUNS_DIR).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (!dir) return null;
  const runs = (await fs.readdir(dir))
    .filter((f) => /^run-.*\.json$/.test(f))
    .sort();
  if (runs.length === 0) return null;
  // Filenames are run-YYYYMMDD_HHMMSS.json, so lexical sort == chronological.
  return path.join(MINER_RUNS_DIR, runs[runs.length - 1]);
}

app.get("/api/patterns", async (_req, res) => {
  try {
    const reportPath = await findLatestRunReport();
    if (!reportPath) {
      res.status(404).json({ error: "No miner run report found" });
      return;
    }
    const report = JSON.parse(await readContained(INSIGHTS_ROOT, reportPath, [".json"]));
    const counts: Record<string, number> = report.pattern_counts || {};
    const details: Record<string, any> = report.pattern_details || {};
    // Per-pattern notes-vs-rewrites split is top-level, keyed by pattern id.
    const patternNoteRewrite: Record<string, any> =
      report.pattern_note_rewrite || {};

    const ids = new Set([...Object.keys(counts), ...Object.keys(details)]);
    const patterns: RankedPattern[] = [...ids].map((id) => {
      const d = details[id] || {};
      const noteRewrite = patternNoteRewrite[id];
      return {
        id,
        name: d.name || id,
        count: d.count ?? counts[id] ?? 0,
        examples: Array.isArray(d.examples) ? d.examples : [],
        ...(noteRewrite ? { note_rewrite: noteRewrite } : {}),
      };
    });
    patterns.sort((a, b) => b.count - a.count);

    // Run-level intent: the 6-way edit-intent breakdown (intent_counts) and the
    // 2-way notes-vs-rewrites headline. Both absent on older run reports, in
    // which case the corresponding UI block simply doesn't render.
    const intentBreakdown =
      report.intent_counts ?? report.intent_breakdown ?? report.intents ?? null;
    const noteVsRewrite = report.note_vs_rewrite ?? null;

    res.json({
      run_ts: report.run_ts ?? null,
      total_files: report.total_files ?? null,
      total_paragraphs: report.total_paragraphs ?? null,
      total_revised: report.total_revised ?? null,
      model_used: report.model_used ?? null,
      patterns,
      delta: report.delta ?? null,
      note_vs_rewrite: noteVsRewrite,
      intent_breakdown: intentBreakdown,
    });
  } catch (err) {
    console.error("GET /api/patterns", err);
    res.status(500).json({ error: "Failed to load patterns" });
  }
});

app.get("/api/voice-spec", async (_req, res) => {
  try {
    if (!VOICE_SPEC_PATH) {
      res.status(404).json({ error: "Voice spec not found" });
      return;
    }
    const md = await readOptional(INSIGHTS_ROOT, VOICE_SPEC_PATH, [".md"]);
    if (md === null) { res.status(404).json({ error: "Voice spec not found" }); return; }
    res.type("text/markdown").send(md);
  } catch (err) {
    console.error("GET /api/voice-spec", err);
    res.status(500).json({ error: "Failed to load voice spec" });
  }
});

// SPA fallback for client-side routing
if (existsSync(distPath)) {
  // Express 5 / path-to-regexp v8: a bare "*" path throws "Missing parameter
  // name". Use the named splat so the SPA fallback works in production mode.
  app.get("/*splat", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

if (process.env.CVP_DISABLE_WATCH !== "1") {
  watch(DRAFTS_DIR, { ignoreInitial: true }).on("all", (event, filepath) => {
    console.log(`[drafts] ${event}: ${path.basename(filepath)}`);
  });
}

app.listen(PORT, HOST, () => {
  console.log(`ContentViewPro server running on http://${HOST}:${PORT}`);
  console.log(`Watching: ${DRAFTS_DIR}`);
});
