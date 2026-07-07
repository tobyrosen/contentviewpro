import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { watch } from "chokidar";
import matter from "gray-matter";

const PORT = parseInt(process.env.PORT || "3033", 10);
// Bind the API to loopback by default. The frontend reaches it through Vite's
// same-machine localhost proxy, so override HOST only when intentionally exposing
// the development server.
const HOST = process.env.HOST || "127.0.0.1";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:5173";
const CVP_TOKEN = process.env.CVP_TOKEN || "";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(ROOT, process.env.CVP_DATA_DIR || "data");
const DRAFTS_DIR = path.join(DATA_DIR, "drafts");
const REVIEWS_DIR = path.join(DATA_DIR, "reviews");
const STATE_DIR = path.join(DATA_DIR, "state");

for (const dir of [DRAFTS_DIR, REVIEWS_DIR, STATE_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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
  const files = await fs.readdir(DRAFTS_DIR);
  const mdFiles = files.filter((f) => f.endsWith(".md"));
  const articles: ArticleMeta[] = [];

  for (const filename of mdFiles) {
    const content = await fs.readFile(path.join(DRAFTS_DIR, filename), "utf-8");
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
  const statePath = path.join(STATE_DIR, `${articleId}.json`);
  if (!existsSync(statePath)) return null;
  const raw = await fs.readFile(statePath, "utf-8");
  return JSON.parse(raw);
}

async function saveState(articleId: string, state: ReviewState): Promise<void> {
  await fs.writeFile(
    path.join(STATE_DIR, `${articleId}.json`),
    JSON.stringify(state, null, 2),
  );
}

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.use(express.json());

// Auth middleware: enforced only when CVP_TOKEN is set
app.use("/api", (req, res, next) => {
  if (!CVP_TOKEN) {
    next();
    return;
  }
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${CVP_TOKEN}`) {
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
        const content = await fs.readFile(
          path.join(DRAFTS_DIR, article.filename),
          "utf-8",
        );
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
    const filepath = path.join(DRAFTS_DIR, filename);

    if (!existsSync(filepath)) {
      res.status(404).json({ error: "Article not found" });
      return;
    }

    const content = await fs.readFile(filepath, "utf-8");
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
    console.error(`GET /api/articles/${id}`, err);
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
    console.error(`PUT /api/articles/${id}/state`, err);
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

    const draftPath = path.join(DRAFTS_DIR, `${id}.md`);
    if (existsSync(draftPath)) {
      const content = await fs.readFile(draftPath, "utf-8");
      const { meta } = parseDraft(content);
      if (meta.round) review.round = meta.round;
    }

    await fs.writeFile(
      path.join(REVIEWS_DIR, `${id}.json`),
      JSON.stringify(review, null, 2),
    );
    res.json({ ok: true, reviewPath: path.join(REVIEWS_DIR, `${id}.json`) });
  } catch (err) {
    console.error(`POST /api/articles/${id}/submit`, err);
    res.status(500).json({ error: "Failed to submit review" });
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

watch(DRAFTS_DIR, { ignoreInitial: true }).on("all", (event, filepath) => {
  console.log(`[drafts] ${event}: ${path.basename(filepath)}`);
});

app.listen(PORT, HOST, () => {
  console.log(`ContentViewPro server running on http://${HOST}:${PORT}`);
  console.log(`Watching: ${DRAFTS_DIR}`);
});
