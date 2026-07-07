import { invoke } from "@tauri-apps/api/core";

const IS_TAURI = Boolean(
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__,
);
const BASE = "/api";

// --- Browser-mode auth (no-op in Tauri) ---

export function getToken(): string {
  return localStorage.getItem("cvp_token") || "";
}

export function setToken(token: string): void {
  localStorage.setItem("cvp_token", token);
}

export function clearToken(): void {
  localStorage.removeItem("cvp_token");
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
