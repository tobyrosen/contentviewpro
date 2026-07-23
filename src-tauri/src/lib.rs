use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

// ─── Data types ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ParagraphState {
    index: usize,
    original: String,
    status: String,
    notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ReviewState {
    #[serde(rename = "articleId")]
    article_id: String,
    paragraphs: Vec<ParagraphState>,
    order: Vec<usize>,
    submitted: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ArticleSummary {
    id: String,
    filename: String,
    title: String,
    client: String,
    #[serde(rename = "type")]
    article_type: String,
    date: String,
    round: u32,
    total: usize,
    reviewed: usize,
    submitted: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Paragraph {
    index: usize,
    text: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Article {
    id: String,
    filename: String,
    meta: HashMap<String, Value>,
    paragraphs: Vec<Paragraph>,
    state: ReviewState,
}

// ─── LAN server state ────────────────────────────────────────────────────────

pub struct LanState {
    handle: Arc<Mutex<Option<JoinHandle<()>>>>,
    url: Arc<Mutex<Option<String>>>,
}

impl LanState {
    fn new() -> Self {
        Self {
            handle: Arc::new(Mutex::new(None)),
            url: Arc::new(Mutex::new(None)),
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn parse_draft(content: &str) -> (HashMap<String, Value>, Vec<Paragraph>) {
    let normalized = content.replace("\r\n", "\n");
    let mut meta = HashMap::new();
    let mut body = normalized.as_str();

    if let Some(rest) = body.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---\n") {
            let yaml = &rest[..end];
            body = &rest[end + 5..];
            if let Ok(Value::Object(map)) = serde_yaml::from_str::<Value>(yaml) {
                for (key, v) in map {
                    meta.insert(key, v);
                }
            }
        }
    }

    let mut blocks = Vec::new();
    let mut current = Vec::new();
    for line in body.lines() {
        if line.trim().is_empty() {
            if !current.is_empty() {
                blocks.push(current.join("\n"));
                current.clear();
            }
        } else {
            current.push(line);
        }
    }
    if !current.is_empty() {
        blocks.push(current.join("\n"));
    }

    let paragraphs = blocks
        .into_iter()
        .enumerate()
        .map(|(index, text)| Paragraph {
            index,
            text: text.trim().to_string(),
        })
        .collect();

    (meta, paragraphs)
}

fn meta_str(meta: &HashMap<String, Value>, key: &str) -> String {
    meta.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn meta_u32(meta: &HashMap<String, Value>, key: &str, default: u32) -> u32 {
    meta.get(key)
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .unwrap_or(default)
}

fn validate_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
}

fn finalize_review(state: &mut ReviewState) -> Result<(), String> {
    if state.submitted {
        return Err("Already submitted".to_string());
    }

    for paragraph in &mut state.paragraphs {
        if paragraph.status == "approved" {
            paragraph.notes = None;
        }
    }
    state.submitted = true;
    Ok(())
}

fn get_workspace(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let settings = std::fs::read_to_string(app_data.join("settings.json"))
        .map_err(|_| "Workspace not configured — open the app and choose a folder".to_string())?;
    let json: Value = serde_json::from_str(&settings).map_err(|e| e.to_string())?;
    json["workspacePath"]
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| "Workspace not configured".to_string())
}

fn atomic_write(path: &std::path::Path, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

fn get_local_ip() -> Result<String, String> {
    // Connect a UDP socket (no data sent) so OS picks the right interface
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket.connect("8.8.8.8:80").map_err(|e| e.to_string())?;
    Ok(socket
        .local_addr()
        .map_err(|e| e.to_string())?
        .ip()
        .to_string())
}

// ─── Core business logic (shared by IPC + LAN) ───────────────────────────────

async fn core_list_articles(app: &tauri::AppHandle) -> Result<Vec<ArticleSummary>, String> {
    let workspace = get_workspace(app)?;
    let drafts_dir = workspace.join("drafts");
    let state_dir = workspace.join("state");

    std::fs::create_dir_all(&drafts_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&state_dir).map_err(|e| e.to_string())?;

    let mut summaries = Vec::new();
    for entry in std::fs::read_dir(&drafts_dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let name = entry.file_name();
        let filename = name.to_string_lossy();
        if !filename.ends_with(".md") {
            continue;
        }

        let id = filename.trim_end_matches(".md").to_string();
        let Ok(content) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let (meta, paragraphs) = parse_draft(&content);

        let state: Option<ReviewState> =
            std::fs::read_to_string(state_dir.join(format!("{id}.json")))
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok());

        let total = paragraphs.len();
        let reviewed = state
            .as_ref()
            .map(|s| {
                s.paragraphs
                    .iter()
                    .filter(|p| p.status != "pending")
                    .count()
            })
            .unwrap_or(0);
        let submitted = state.as_ref().map(|s| s.submitted).unwrap_or(false);

        summaries.push(ArticleSummary {
            title: meta
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or(&filename)
                .to_string(),
            id,
            filename: filename.to_string(),
            client: meta_str(&meta, "client"),
            article_type: meta_str(&meta, "type"),
            date: meta_str(&meta, "date"),
            round: meta_u32(&meta, "round", 1),
            total,
            reviewed,
            submitted,
        });
    }
    Ok(summaries)
}

async fn core_get_article(app: &tauri::AppHandle, id: &str) -> Result<Article, String> {
    if !validate_id(id) {
        return Err("Invalid article ID".to_string());
    }

    let workspace = get_workspace(app)?;
    let drafts_dir = workspace.join("drafts");
    let state_dir = workspace.join("state");
    std::fs::create_dir_all(&state_dir).map_err(|e| e.to_string())?;

    let filepath = drafts_dir.join(format!("{id}.md"));
    if !filepath.exists() {
        return Err("Article not found".to_string());
    }

    let content = std::fs::read_to_string(&filepath).map_err(|e| e.to_string())?;
    let (meta, paragraphs) = parse_draft(&content);

    let state_path = state_dir.join(format!("{id}.json"));
    let state = if state_path.exists() {
        serde_json::from_str::<ReviewState>(
            &std::fs::read_to_string(&state_path).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?
    } else {
        let new_state = ReviewState {
            article_id: id.to_string(),
            paragraphs: paragraphs
                .iter()
                .map(|p| ParagraphState {
                    index: p.index,
                    original: p.text.clone(),
                    status: "pending".to_string(),
                    notes: None,
                })
                .collect(),
            order: paragraphs.iter().map(|p| p.index).collect(),
            submitted: false,
        };
        atomic_write(
            &state_path,
            &serde_json::to_string_pretty(&new_state).map_err(|e| e.to_string())?,
        )?;
        new_state
    };

    Ok(Article {
        id: id.to_string(),
        filename: format!("{id}.md"),
        meta,
        paragraphs,
        state,
    })
}

async fn core_save_state(
    app: &tauri::AppHandle,
    id: &str,
    state: ReviewState,
) -> Result<(), String> {
    if !validate_id(id) {
        return Err("Invalid article ID".to_string());
    }

    let workspace = get_workspace(app)?;
    let state_dir = workspace.join("state");
    std::fs::create_dir_all(&state_dir).map_err(|e| e.to_string())?;

    let state_with_id = ReviewState {
        article_id: id.to_string(),
        ..state
    };
    atomic_write(
        &state_dir.join(format!("{id}.json")),
        &serde_json::to_string_pretty(&state_with_id).map_err(|e| e.to_string())?,
    )
}

async fn core_submit_review(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    if !validate_id(id) {
        return Err("Invalid article ID".to_string());
    }

    let workspace = get_workspace(app)?;
    let drafts_dir = workspace.join("drafts");
    let state_dir = workspace.join("state");
    let reviews_dir = workspace.join("reviews");
    std::fs::create_dir_all(&reviews_dir).map_err(|e| e.to_string())?;

    let state_path = state_dir.join(format!("{id}.json"));
    if !state_path.exists() {
        return Err("No review state found".to_string());
    }

    let mut state: ReviewState =
        serde_json::from_str(&std::fs::read_to_string(&state_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;

    finalize_review(&mut state)?;
    atomic_write(
        &state_path,
        &serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?,
    )?;

    let mut round: u32 = 1;
    let draft_path = drafts_dir.join(format!("{id}.md"));
    if draft_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&draft_path) {
            let (meta, _) = parse_draft(&content);
            round = meta_u32(&meta, "round", 1);
        }
    }

    let review = serde_json::json!({
        "source": format!("{id}.md"),
        "reviewedAt": chrono::Utc::now().to_rfc3339(),
        "round": round,
        "paragraphs": state.paragraphs,
        "order": state.order,
    });

    atomic_write(
        &reviews_dir.join(format!("{id}.json")),
        &serde_json::to_string_pretty(&review).map_err(|e| e.to_string())?,
    )
}

// ─── Tauri IPC commands ──────────────────────────────────────────────────────

#[tauri::command]
async fn list_articles(app: tauri::AppHandle) -> Result<Vec<ArticleSummary>, String> {
    core_list_articles(&app).await
}

#[tauri::command]
async fn get_article(app: tauri::AppHandle, id: String) -> Result<Article, String> {
    core_get_article(&app, &id).await
}

#[tauri::command]
async fn save_state(app: tauri::AppHandle, id: String, state: ReviewState) -> Result<(), String> {
    core_save_state(&app, &id, state).await
}

#[tauri::command]
async fn submit_review(app: tauri::AppHandle, id: String) -> Result<(), String> {
    core_submit_review(&app, &id).await
}

// ─── LAN server (axum) ───────────────────────────────────────────────────────

fn err_response(msg: &str) -> axum::response::Response {
    use axum::response::IntoResponse;
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        axum::Json(serde_json::json!({"error": msg})),
    )
        .into_response()
}

fn not_found(msg: &str) -> axum::response::Response {
    use axum::response::IntoResponse;
    (
        axum::http::StatusCode::NOT_FOUND,
        axum::Json(serde_json::json!({"error": msg})),
    )
        .into_response()
}

async fn lan_list_articles(
    axum::Extension(app): axum::Extension<tauri::AppHandle>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    match core_list_articles(&app).await {
        Ok(list) => axum::Json(list).into_response(),
        Err(e) => err_response(&e),
    }
}

async fn lan_get_article(
    axum::Extension(app): axum::Extension<tauri::AppHandle>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    match core_get_article(&app, &id).await {
        Ok(article) => axum::Json(article).into_response(),
        Err(e) if e.contains("not found") => not_found(&e),
        Err(e) => err_response(&e),
    }
}

async fn lan_save_state(
    axum::Extension(app): axum::Extension<tauri::AppHandle>,
    axum::extract::Path(id): axum::extract::Path<String>,
    axum::Json(body): axum::Json<ReviewState>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    match core_save_state(&app, &id, body).await {
        Ok(()) => axum::Json(serde_json::json!({"ok": true})).into_response(),
        Err(e) => err_response(&e),
    }
}

async fn lan_submit_review(
    axum::Extension(app): axum::Extension<tauri::AppHandle>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    match core_submit_review(&app, &id).await {
        Ok(()) => axum::Json(serde_json::json!({"ok": true})).into_response(),
        Err(e) if e.contains("not found") => not_found(&e),
        Err(e) => err_response(&e),
    }
}

fn build_lan_router(app: tauri::AppHandle) -> axum::Router {
    use axum::routing::{get, post, put};
    axum::Router::new()
        .route("/api/articles", get(lan_list_articles))
        .route("/api/articles/:id", get(lan_get_article))
        .route("/api/articles/:id/state", put(lan_save_state))
        .route("/api/articles/:id/submit", post(lan_submit_review))
        .layer(axum::Extension(app))
}

#[tauri::command]
async fn start_lan_server(
    app: tauri::AppHandle,
    port: u16,
    lan: tauri::State<'_, LanState>,
) -> Result<String, String> {
    let mut handle = lan.handle.lock().await;
    if let Some(h) = handle.take() {
        h.abort();
    }

    let bind_addr = std::env::var("CVP_BIND_ADDR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let listener = tokio::net::TcpListener::bind(format!("{bind_addr}:{port}"))
        .await
        .map_err(|e| format!("Port {port} unavailable: {e}"))?;

    let router = build_lan_router(app);
    *handle = Some(tokio::spawn(async move {
        axum::serve(listener, router).await.ok();
    }));

    let url_host = if bind_addr == "0.0.0.0" {
        get_local_ip()?
    } else {
        bind_addr
    };
    let url = format!("http://{url_host}:{port}");
    *lan.url.lock().await = Some(url.clone());
    Ok(url)
}

#[tauri::command]
async fn stop_lan_server(lan: tauri::State<'_, LanState>) -> Result<(), String> {
    if let Some(h) = lan.handle.lock().await.take() {
        h.abort();
    }
    *lan.url.lock().await = None;
    Ok(())
}

#[tauri::command]
async fn get_lan_status(lan: tauri::State<'_, LanState>) -> Result<Option<String>, String> {
    Ok(lan.url.lock().await.clone())
}

// ─── App entry point ─────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(LanState::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            list_articles,
            get_article,
            save_state,
            submit_review,
            start_lan_server,
            stop_lan_server,
            get_lan_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_draft_normalizes_frontmatter_and_paragraphs() {
        let content = concat!(
            "---\r\n",
            "title: Review me\r\n",
            "round: 3\r\n",
            "---\r\n",
            "\r\n",
            "First line\r\n",
            "continues here.\r\n",
            "   \r\n",
            "Second paragraph.\r\n",
        );

        let (meta, paragraphs) = parse_draft(content);

        assert_eq!(meta_str(&meta, "title"), "Review me");
        assert_eq!(meta_u32(&meta, "round", 1), 3);
        assert_eq!(paragraphs.len(), 2);
        assert_eq!(paragraphs[0].index, 0);
        assert_eq!(paragraphs[0].text, "First line\ncontinues here.");
        assert_eq!(paragraphs[1].text, "Second paragraph.");
    }

    #[test]
    fn parse_draft_without_frontmatter_keeps_nonempty_blocks() {
        let (_, paragraphs) = parse_draft("Opening\nwrapped\n\n\nClosing\n");

        assert_eq!(paragraphs.len(), 2);
        assert_eq!(paragraphs[0].text, "Opening\nwrapped");
        assert_eq!(paragraphs[1].text, "Closing");
    }

    #[test]
    fn article_ids_reject_path_traversal_and_empty_values() {
        for valid in ["draft-1", "client_round_2", "Article42"] {
            assert!(validate_id(valid), "{valid} should be valid");
        }
        for invalid in ["", ".", "../draft", "draft/name", "draft name"] {
            assert!(!validate_id(invalid), "{invalid} should be invalid");
        }
    }

    #[test]
    fn finalizing_review_clears_only_approved_notes_and_is_one_way() {
        let mut state = ReviewState {
            article_id: "draft-1".to_string(),
            paragraphs: vec![
                ParagraphState {
                    index: 0,
                    original: "Approved text".to_string(),
                    status: "approved".to_string(),
                    notes: Some("stale note".to_string()),
                },
                ParagraphState {
                    index: 1,
                    original: "Needs work".to_string(),
                    status: "revised".to_string(),
                    notes: Some("keep this note".to_string()),
                },
            ],
            order: vec![1, 0],
            submitted: false,
        };

        finalize_review(&mut state).expect("first submission should succeed");

        assert!(state.submitted);
        assert_eq!(state.paragraphs[0].notes, None);
        assert_eq!(state.paragraphs[1].notes.as_deref(), Some("keep this note"),);
        assert_eq!(state.order, vec![1, 0]);
        assert_eq!(
            finalize_review(&mut state),
            Err("Already submitted".to_string()),
        );
    }
}
