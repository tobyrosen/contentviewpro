import { invoke } from "@tauri-apps/api/core";

const IS_TAURI = Boolean(
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__,
);
const BASE = "/api";

// Remove a token left by older releases without reading or migrating it.
try { window.localStorage.removeItem("cvp_token"); } catch { /* storage may be unavailable */ }

// --- Browser-mode auth (no-op in Tauri) ---

export function getToken(): string {
  return sessionStorage.getItem("cvp_token") || "";
}

export function setToken(token: string): void {
  sessionStorage.setItem("cvp_token", token);
}

export function clearToken(): void {
  sessionStorage.removeItem("cvp_token");
}

async function authFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(input, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${getToken()}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event("cvp:unauthorized"));
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res;
}

// --- Types ---

export interface ArticleSummary {
  id: string;
  filename: string;
  title: string;
  client: string;
  type: string;
  date: string;
  round: number;
  total: number;
  reviewed: number;
  submitted: boolean;
}

export interface ParagraphState {
  index: number;
  original: string;
  status: "pending" | "approved" | "revised";
  notes: string | null;
}

export interface ReviewState {
  articleId: string;
  paragraphs: ParagraphState[];
  order: number[];
  submitted: boolean;
}

export interface ArticleMeta {
  title?: string;
  client?: string;
  type?: string;
  date?: string;
  round?: number;
  // Frontmatter is user-authored YAML, so tolerate arbitrary extra keys.
  [key: string]: unknown;
}

export interface Article {
  id: string;
  filename: string;
  meta: ArticleMeta;
  paragraphs: { index: number; text: string }[];
  state: ReviewState;
}

// --- API functions: invoke() in Tauri, fetch() in browser ---

export async function fetchArticles(): Promise<ArticleSummary[]> {
  if (IS_TAURI) return invoke<ArticleSummary[]>("list_articles");
  const res = await authFetch(`${BASE}/articles`);
  return res.json();
}

export async function fetchArticle(id: string): Promise<Article> {
  if (IS_TAURI) return invoke<Article>("get_article", { id });
  const res = await authFetch(`${BASE}/articles/${id}`);
  return res.json();
}

export async function saveReviewState(
  id: string,
  state: ReviewState,
): Promise<void> {
  if (IS_TAURI) return invoke("save_state", { id, state });
  await authFetch(`${BASE}/articles/${id}/state`, {
    method: "PUT",
    body: JSON.stringify(state),
  });
}

export async function submitReview(id: string): Promise<void> {
  if (IS_TAURI) return invoke("submit_review", { id });
  await authFetch(`${BASE}/articles/${id}/submit`, { method: "POST" });
}

// --- CVP Insights: top recurring edits + voice spec ---

export interface PatternExample {
  source: string;
  index: number;
  original: string;
  notes: string | null;
}

export interface RankedPattern {
  id: string;
  name: string;
  count: number;
  examples: PatternExample[];
  // Per-pattern notes-vs-rewrites split, present once the miner tags intent.
  note_rewrite?: Record<string, number>;
}

interface DeltaEntry {
  pattern_id: string;
  count: number;
  prev?: number;
  delta?: number;
}

export interface PatternsResponse {
  run_ts: string | null;
  total_files: number | null;
  total_paragraphs: number | null;
  total_revised: number | null;
  model_used: string | null;
  patterns: RankedPattern[];
  delta: {
    new_patterns?: DeltaEntry[];
    rising_patterns?: DeltaEntry[];
    stable?: DeltaEntry[];
  } | null;
  // 2-way headline: how often the reviewer rewrote text vs left a note.
  note_vs_rewrite: Record<string, number> | null;
  // 6-way edit-intent breakdown (intent_counts).
  intent_breakdown: Record<string, number> | null;
}

// Insights is a browser/dev surface backed by the Express server; there is no
// Tauri command for it, so these always go over HTTP.
export async function fetchPatterns(): Promise<PatternsResponse> {
  const res = await authFetch(`${BASE}/patterns`);
  return res.json();
}

export async function fetchVoiceSpec(): Promise<string> {
  const res = await authFetch(`${BASE}/voice-spec`);
  return res.text();
}
