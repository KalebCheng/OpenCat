//! Application settings and query history — the parts of the workspace that are
//! not connection profiles.

use serde::{Deserialize, Serialize};

/// UI theme selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    /// Follow the operating system.
    #[default]
    System,
    Light,
    Dark,
}

fn d_ui_font_size() -> u32 {
    13
}
fn d_editor_font_size() -> u32 {
    13
}
fn d_tab_size() -> u32 {
    2
}
fn d_page_size() -> u32 {
    500
}
fn d_max_rows() -> u32 {
    50_000
}
fn d_history_limit() -> u32 {
    2_000
}
fn d_true() -> bool {
    true
}
fn d_null_display() -> String {
    "(NULL)".into()
}
fn d_date_format() -> String {
    "%Y-%m-%d %H:%M:%S".into()
}
fn d_ui_font() -> String {
    String::new()
}
fn d_editor_font() -> String {
    "JetBrains Mono, Cascadia Code, Consolas, monospace".into()
}

/// Everything configurable through the Settings dialog.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub theme: Theme,
    /// Accent colour token, e.g. `violet`, `blue`, `emerald`.
    #[serde(default = "default_accent")]
    pub accent: String,
    #[serde(default = "d_ui_font")]
    pub ui_font_family: String,
    #[serde(default = "d_ui_font_size")]
    pub ui_font_size: u32,

    #[serde(default = "d_editor_font")]
    pub editor_font_family: String,
    #[serde(default = "d_editor_font_size")]
    pub editor_font_size: u32,
    #[serde(default = "d_tab_size")]
    pub editor_tab_size: u32,
    #[serde(default)]
    pub editor_word_wrap: bool,
    #[serde(default = "d_true")]
    pub editor_line_numbers: bool,
    /// Fold long result text after N characters; 0 disables folding.
    #[serde(default)]
    pub truncate_cell_chars: u32,

    #[serde(default = "d_page_size")]
    pub default_page_size: u32,
    #[serde(default = "d_max_rows")]
    pub max_rows: u32,
    #[serde(default = "d_true")]
    pub auto_commit: bool,
    #[serde(default = "d_true")]
    pub confirm_destructive: bool,
    #[serde(default = "d_true")]
    pub show_system_databases: bool,

    #[serde(default = "d_history_limit")]
    pub history_limit: u32,
    #[serde(default = "d_true")]
    pub save_query_history: bool,
    #[serde(default = "d_null_display")]
    pub null_display: String,
    #[serde(default = "d_date_format")]
    pub date_format: String,

    #[serde(default)]
    pub export_default_dir: Option<String>,
    #[serde(default = "default_locale")]
    pub locale: String,
}

fn default_accent() -> String {
    "violet".into()
}
fn default_locale() -> String {
    "zh-CN".into()
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            theme: Theme::default(),
            accent: default_accent(),
            ui_font_family: d_ui_font(),
            ui_font_size: d_ui_font_size(),
            editor_font_family: d_editor_font(),
            editor_font_size: d_editor_font_size(),
            editor_tab_size: d_tab_size(),
            editor_word_wrap: false,
            editor_line_numbers: true,
            truncate_cell_chars: 0,
            default_page_size: d_page_size(),
            max_rows: d_max_rows(),
            auto_commit: true,
            confirm_destructive: true,
            show_system_databases: true,
            history_limit: d_history_limit(),
            save_query_history: true,
            null_display: d_null_display(),
            date_format: d_date_format(),
            export_default_dir: None,
            locale: default_locale(),
        }
    }
}

/// One executed statement, recorded for the History panel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub profile_id: String,
    #[serde(default)]
    pub profile_name: String,
    #[serde(default)]
    pub database: Option<String>,
    pub sql: String,
    pub started_at: String,
    pub elapsed_ms: f64,
    #[serde(default)]
    pub row_count: i64,
    pub success: bool,
    #[serde(default)]
    pub error: Option<String>,
    /// True when the statement came from the data grid rather than the editor.
    #[serde(default)]
    pub background: bool,
}

impl HistoryEntry {
    pub fn new(profile_id: impl Into<String>, sql: impl Into<String>) -> Self {
        HistoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            profile_id: profile_id.into(),
            profile_name: String::new(),
            database: None,
            sql: sql.into(),
            started_at: chrono::Utc::now().to_rfc3339(),
            elapsed_ms: 0.0,
            row_count: 0,
            success: true,
            error: None,
            background: false,
        }
    }
}

/// A user-saved snippet, shown in the "Saved Queries" panel and the editor's
/// snippet picker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub database: Option<String>,
    pub sql: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub updated_at: String,
}

impl SavedQuery {
    pub fn new(name: impl Into<String>, sql: impl Into<String>) -> Self {
        SavedQuery {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            profile_id: None,
            database: None,
            sql: sql.into(),
            tags: Vec::new(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}
