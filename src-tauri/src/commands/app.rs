//! Application-level commands: identity, settings, history, snippets and plain
//! file access for the SQL editor.

use tauri::{Manager, State};

use opencat_core::settings::{AppSettings, HistoryEntry, SavedQuery};
use opencat_core::APP_NAME;

use crate::error::{coded, CmdResult};
use crate::state::AppState;

/// Static facts the UI shows in the About panel and the status bar.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub workspace_dir: String,
    pub platform: String,
    pub arch: String,
    pub engines: Vec<EngineInfo>,
}

/// One supported database engine.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub kind: String,
    pub name: String,
    pub default_port: Option<u16>,
    pub file_based: bool,
}

#[tauri::command]
pub async fn app_info(state: State<'_, AppState>) -> CmdResult<AppInfo> {
    let dir = state.with_workspace(|ws| ws.dir().to_string_lossy().to_string());

    let engines = opencat_core::model::DbKind::ALL
        .iter()
        .map(|kind| EngineInfo {
            kind: kind.as_str().to_string(),
            name: kind.display_name().to_string(),
            default_port: kind.default_port(),
            file_based: kind.is_file_based(),
        })
        .collect();

    Ok(AppInfo {
        name: APP_NAME.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        workspace_dir: dir,
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        engines,
    })
}

/// Current application settings.
#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> CmdResult<AppSettings> {
    Ok(state.with_workspace(|ws| ws.settings().clone()))
}

/// Persist new settings and return the stored copy.
#[tauri::command]
pub async fn save_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> CmdResult<AppSettings> {
    Ok(state.with_workspace_mut(|ws| ws.set_settings(settings))?)
}

// -- query history -----------------------------------------------------------

#[tauri::command]
pub async fn list_history(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> CmdResult<Vec<HistoryEntry>> {
    Ok(state.with_workspace(|ws| {
        let mut history = ws.history();
        if let Some(limit) = limit {
            history.truncate(limit as usize);
        }
        history
    }))
}

#[tauri::command]
pub async fn clear_history(state: State<'_, AppState>) -> CmdResult<()> {
    Ok(state.with_workspace_mut(|ws| ws.clear_history())?)
}

#[tauri::command]
pub async fn delete_history(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    Ok(state.with_workspace_mut(|ws| ws.delete_history(&id))?)
}

// -- saved queries -----------------------------------------------------------

#[tauri::command]
pub async fn list_snippets(state: State<'_, AppState>) -> CmdResult<Vec<SavedQuery>> {
    Ok(state.with_workspace(|ws| ws.snippets()))
}

#[tauri::command]
pub async fn save_snippet(
    state: State<'_, AppState>,
    snippet: SavedQuery,
) -> CmdResult<SavedQuery> {
    Ok(state.with_workspace_mut(|ws| ws.upsert_snippet(snippet))?)
}

#[tauri::command]
pub async fn delete_snippet(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    Ok(state.with_workspace_mut(|ws| ws.delete_snippet(&id))?)
}

// -- file access -------------------------------------------------------------

/// Read a UTF-8 text file (the editor's "Open SQL file").
#[tauri::command]
pub async fn read_text_file(path: String) -> CmdResult<String> {
    let metadata = std::fs::metadata(&path)?;
    if metadata.len() > 64 * 1024 * 1024 {
        return Err(coded("invalid", "that file is larger than 64 MiB"));
    }
    Ok(std::fs::read_to_string(&path)?)
}

/// Write a UTF-8 text file (the editor's "Save SQL file").
#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> CmdResult<()> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, contents)?;
    Ok(())
}

/// Does this path exist and is it a file?
#[tauri::command]
pub async fn path_exists(path: String) -> CmdResult<bool> {
    Ok(std::path::Path::new(&path).is_file())
}

/// Reveal the workspace directory in the system file manager.
#[tauri::command]
pub async fn reveal_workspace(app: tauri::AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let dir = state.with_workspace(|ws| ws.dir().to_path_buf());
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| crate::error::other(format!("could not open the workspace folder: {e}")))?;
    Ok(())
}

/// Copy text to the system clipboard.
#[tauri::command]
pub async fn copy_to_clipboard(app: tauri::AppHandle, text: String) -> CmdResult<()> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(text)
        .map_err(|e| crate::error::other(format!("clipboard error: {e}")))?;
    Ok(())
}

/// Read text from the system clipboard.
#[tauri::command]
pub async fn read_clipboard(app: tauri::AppHandle) -> CmdResult<String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .read_text()
        .map_err(|e| crate::error::other(format!("clipboard error: {e}")))
}

/// Show the main window, creating focus on it (used by the tray/single-instance
/// style entry points).
#[tauri::command]
pub async fn focus_main_window(app: tauri::AppHandle) -> CmdResult<()> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(())
}
