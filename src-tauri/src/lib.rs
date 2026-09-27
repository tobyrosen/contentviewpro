use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::io::{Read, Write};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
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
    let workspace = json["workspacePath"]
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| "Workspace not configured".to_string())?;
    checked_root(&workspace)
}

fn checked_root(root: &Path) -> Result<PathBuf, String> {
    let meta = std::fs::symlink_metadata(root).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || !meta.is_dir() { return Err("Unsafe workspace root".into()); }
    root.canonicalize().map_err(|e| e.to_string())
}

fn checked_dir(root: &Path, name: &str, create: bool) -> Result<PathBuf, String> {
    let root = checked_root(root)?;
    if !matches!(name, "drafts" | "state" | "reviews") { return Err("Invalid workspace directory".into()); }
    let dir = root.join(name);
    if create && !dir.exists() { std::fs::create_dir(&dir).map_err(|e| e.to_string())?; }
    let meta = std::fs::symlink_metadata(&dir).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || !meta.is_dir() || dir.canonicalize().map_err(|e| e.to_string())? != dir {
        return Err("Unsafe workspace directory".into());
    }
    Ok(dir)
}

fn checked_file(root: &Path, dir: &str, name: &str, create_dir: bool) -> Result<PathBuf, String> {
    let parent = checked_dir(root, dir, create_dir)?;
    if !name.starts_with('.') && !name.contains('/') && !name.contains('\\') &&
       ((dir == "drafts" && name.ends_with(".md")) ||
        (dir != "drafts" && name.ends_with(".json"))) {
        let path = parent.join(name);
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => return Err("Unsafe workspace file".into()),
            Ok(_) if !path.canonicalize().map_err(|e| e.to_string())?.starts_with(checked_root(root)?) => return Err("File outside workspace".into()),
            Ok(_) => {},
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            Err(e) => return Err(e.to_string()),
        }
        return Ok(path);
    }
    Err("Invalid workspace filename".into())
}

fn read_workspace(root: &Path, dir: &str, name: &str) -> Result<Option<String>, String> {
    let path = checked_file(root, dir, name, false)?;
    if !path.exists() { return Ok(None); }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(libc::O_NOFOLLOW); }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() { return Err("Unsafe workspace file".into()); }
    let mut content = String::new();
    file.read_to_string(&mut content).map_err(|e| e.to_string())?;
    Ok(Some(content))
}

fn write_workspace(root: &Path, dir: &str, name: &str, content: &str) -> Result<(), String> {
    #[cfg(unix)]
    checked_file(root, dir, name, true)?;
    #[cfg(not(unix))]
    let path = checked_file(root, dir, name, true)?;
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
    let temp_name = format!(".cvp-{}-{}.tmp", std::process::id(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed));
    #[cfg(unix)] {
        use rustix::fs::{openat, renameat, unlinkat, AtFlags, Mode, OFlags, CWD};
        // Keep both directory levels open so a rename of a checked path cannot
        // redirect the temporary file or the final rename outside this root.
        let root_fd = openat(CWD, checked_root(root)?, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW, Mode::empty())
            .map_err(|e| e.to_string())?;
        let dir_fd = openat(&root_fd, dir, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW, Mode::empty())
            .map_err(|e| e.to_string())?;
        let fd = openat(&dir_fd, temp_name.as_str(), OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW, Mode::RUSR | Mode::WUSR)
            .map_err(|e| e.to_string())?;
        let mut file = std::fs::File::from(fd);
        let result = (|| {
            file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            renameat(&dir_fd, temp_name.as_str(), &dir_fd, name).map_err(|e| e.to_string())
        })();
        if result.is_err() { let _ = unlinkat(&dir_fd, temp_name.as_str(), AtFlags::empty()); }
        return result;
    }
    #[cfg(not(unix))] {
    let temp = path.with_file_name(temp_name);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(libc::O_NOFOLLOW); }
    let mut file = options.open(&temp).map_err(|e| e.to_string())?;
    let result = (|| {
        file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        checked_file(root, dir, name, false)?;
        std::fs::rename(&temp, &path).map_err(|e| e.to_string())
    })();
    let _ = std::fs::remove_file(temp);
    result
    }
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

#[tauri::command]
fn get_workspace_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    match get_workspace(&app) {
        Ok(path) => Ok(Some(path.to_string_lossy().into_owned())),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
fn set_workspace_path(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let workspace = checked_root(Path::new(&path))?;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let settings = serde_json::json!({"workspacePath": workspace});
    std::fs::write(data.join("settings.json"), settings.to_string()).map_err(|e| e.to_string())?;
    Ok(workspace.to_string_lossy().into_owned())
}

// ─── Core business logic (shared by IPC + LAN) ───────────────────────────────

async fn core_list_articles(app: &tauri::AppHandle) -> Result<Vec<ArticleSummary>, String> {
    let workspace = get_workspace(app)?;
    let drafts_dir = checked_dir(&workspace, "drafts", true)?;
    checked_dir(&workspace, "state", true)?;

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
        if !validate_id(&id) { continue; }
        let Some(content) = read_workspace(&workspace, "drafts", &filename)? else { continue; };
        let (meta, paragraphs) = parse_draft(&content);

        let state: Option<ReviewState> = read_workspace(&workspace, "state", &format!("{id}.json"))?
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
    checked_dir(&workspace, "drafts", true)?;
    checked_dir(&workspace, "state", true)?;
    let content = read_workspace(&workspace, "drafts", &format!("{id}.md"))?
        .ok_or_else(|| "Article not found".to_string())?;
    let (meta, paragraphs) = parse_draft(&content);

    let state = if let Some(raw) = read_workspace(&workspace, "state", &format!("{id}.json"))? {
        serde_json::from_str::<ReviewState>(&raw).map_err(|e| e.to_string())?
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
        write_workspace(&workspace, "state", &format!("{id}.json"),
            &serde_json::to_string_pretty(&new_state).map_err(|e| e.to_string())?)?;
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
    checked_dir(&workspace, "state", true)?;

    let state_with_id = ReviewState {
        article_id: id.to_string(),
        ..state
    };
    write_workspace(&workspace, "state", &format!("{id}.json"),
        &serde_json::to_string_pretty(&state_with_id).map_err(|e| e.to_string())?)
}

async fn core_submit_review(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    if !validate_id(id) {
        return Err("Invalid article ID".to_string());
    }

    let workspace = get_workspace(app)?;
    checked_dir(&workspace, "reviews", true)?;
    let raw = read_workspace(&workspace, "state", &format!("{id}.json"))?
        .ok_or_else(|| "No review state found".to_string())?;
    let mut state: ReviewState = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    finalize_review(&mut state)?;
    write_workspace(&workspace, "state", &format!("{id}.json"),
        &serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?)?;

    let mut round: u32 = 1;
    if let Some(content) = read_workspace(&workspace, "drafts", &format!("{id}.md"))? {
        let (meta, _) = parse_draft(&content);
        round = meta_u32(&meta, "round", 1);
    }

    let review = serde_json::json!({
        "source": format!("{id}.md"),
        "reviewedAt": chrono::Utc::now().to_rfc3339(),
        "round": round,
        "paragraphs": state.paragraphs,
        "order": state.order,
    });

    write_workspace(&workspace, "reviews", &format!("{id}.json"),
        &serde_json::to_string_pretty(&review).map_err(|e| e.to_string())?)
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

fn lan_bind_address(all_interfaces: bool) -> &'static str {
    if all_interfaces { "0.0.0.0" } else { "127.0.0.1" }
}

fn lan_url(all_interfaces: bool, port: u16, local_ip: impl FnOnce() -> Result<String, String>) -> Result<String, String> {
    let address = if all_interfaces { local_ip()? } else { lan_bind_address(false).to_string() };
    Ok(format!("http://{address}:{port}"))
}

async fn bind_lan_listener(
    all_interfaces: bool, port: u16, local_ip: impl FnOnce() -> Result<String, String>,
) -> Result<(tokio::net::TcpListener, String), String> {
    let url = lan_url(all_interfaces, port, local_ip)?;
    let listener = tokio::net::TcpListener::bind(format!("{}:{port}", lan_bind_address(all_interfaces)))
        .await.map_err(|e| format!("Port {port} unavailable: {e}"))?;
    Ok((listener, url))
}

fn lan_token_matches(provided: Option<&str>, token: &str) -> bool {
    let supplied = provided.and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("");
    let actual = Sha256::digest(supplied.as_bytes());
    let expected = Sha256::digest(token.as_bytes());
    let mut difference = 0u8;
    for i in 0..32 {
        difference |= std::hint::black_box(actual[i] ^ expected[i]);
    }
    !supplied.is_empty() && difference == 0
}

async fn lan_auth(
    axum::Extension(token): axum::Extension<Arc<String>>,
    req: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let provided = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    if !lan_token_matches(provided, token.as_str()) {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({"error": "Unauthorized"})),
        )
            .into_response();
    }
    next.run(req).await
}

fn build_lan_router(app: tauri::AppHandle, token: Arc<String>) -> axum::Router {
    use axum::routing::{get, post, put};
    axum::Router::new()
        .route("/api/articles", get(lan_list_articles))
        .route("/api/articles/:id", get(lan_get_article))
        .route("/api/articles/:id/state", put(lan_save_state))
        .route("/api/articles/:id/submit", post(lan_submit_review))
        .layer(axum::middleware::from_fn(lan_auth))
        .layer(axum::Extension(token))
        .layer(axum::Extension(app))
}

#[tauri::command]
async fn start_lan_server(
    app: tauri::AppHandle,
    port: u16,
    all_interfaces: bool,
    lan: tauri::State<'_, LanState>,
) -> Result<String, String> {
    let mut handle = lan.handle.lock().await;
    if let Some(h) = handle.take() {
        h.abort();
    }
    *lan.url.lock().await = None;

    // Require a token even when bound only to loopback.
    let token = std::env::var("CVP_LAN_TOKEN").unwrap_or_default();
    if token.trim().is_empty() {
        return Err(
            "LAN server requires CVP_LAN_TOKEN to be set (bearer secret). Refusing to start an unauthenticated network server.".to_string(),
        );
    }
    let token = Arc::new(token);

    // Resolve the advertised address before opening a listener. No fallible work
    // remains between spawning the server and publishing its UI state.
    let (listener, url) = bind_lan_listener(all_interfaces, port, get_local_ip).await?;

    let router = build_lan_router(app, token);
    *handle = Some(tokio::spawn(async move {
        axum::serve(listener, router).await.ok();
    }));

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
        .invoke_handler(tauri::generate_handler![
            list_articles,
            get_article,
            save_state,
            submit_review,
            get_workspace_path,
            set_workspace_path,
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
    fn lan_defaults_to_loopback_and_checks_token_digests() {
        assert_eq!(lan_bind_address(false), "127.0.0.1");
        assert_eq!(lan_bind_address(true), "0.0.0.0");
        assert!(lan_token_matches(Some("Bearer secret"), "secret"));
        assert!(!lan_token_matches(Some("Bearer wrong"), "secret"));
        assert!(!lan_token_matches(None, "secret"));
    }

    #[tokio::test]
    async fn lan_address_failure_prevents_startup() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert_eq!(bind_lan_listener(true, port, || Err("no local address".into())).await.err().unwrap(), "no local address");
        assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_rejects_file_and_directory_symlinks() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("cvp-rust-{}-links", std::process::id()));
        let outside = std::env::temp_dir().join(format!("cvp-rust-{}-outside", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let root_link = root.with_extension("link");
        let _ = std::fs::remove_file(&root_link);
        symlink(&root, &root_link).unwrap();
        assert!(checked_root(&root_link).is_err());
        std::fs::remove_file(root_link).unwrap();
        std::fs::create_dir(root.join("state")).unwrap();
        std::fs::write(outside.join("secret.json"), "secret").unwrap();
        symlink(outside.join("secret.json"), root.join("state").join("bad.json")).unwrap();
        assert!(read_workspace(&root, "state", "bad.json").is_err());
        assert!(write_workspace(&root, "state", "bad.json", "{}").is_err());
        std::fs::remove_dir_all(root.join("state")).unwrap();
        symlink(&outside, root.join("state")).unwrap();
        assert!(write_workspace(&root, "state", "new.json", "{}").is_err());
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn workspace_file_paths_stay_contained() {
        let root = std::env::temp_dir().join(format!("cvp-rust-{}-containment", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir(&root).unwrap();
        assert!(write_workspace(&root, "state", "ok.json", "{}").is_ok());
        assert_eq!(read_workspace(&root, "state", "ok.json").unwrap(), Some("{}".into()));
        assert!(checked_file(&root, "state", "../escape.json", false).is_err());
        assert!(checked_file(&root, "state", "/escape.json", false).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

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
