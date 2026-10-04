//! # OpenCat
//!
//! Desktop shell around the OpenCat driver layer. This crate owns:
//!
//! * the Tauri application and its plugin wiring ([`run`])
//! * the persisted workspace and live connection registry ([`state`])
//! * the IPC command surface the React frontend talks to ([`commands`])

pub mod commands;
pub mod error;
pub mod state;

use std::path::PathBuf;

use tauri::Manager;

use opencat_core::APP_DIR;
use state::AppState;

/// The outcome of probing a list of candidate directories.
struct Writables {
    /// The first candidate that accepted a write, if any.
    chosen: Option<PathBuf>,
    /// Every candidate that was tried, with the reason it was rejected.
    failures: Vec<String>,
}

/// Probe a list of candidate directories and return the first that accepts a
/// real file write.
///
/// `create_dir_all` succeeding is not enough: a directory can be created and
/// still reject file writes, so each candidate is verified with a probe file.
/// Failures are always reported, because "nothing worked" on its own tells a
/// user nothing about what to fix.
fn first_writable(candidates: impl IntoIterator<Item = PathBuf>) -> Writables {
    let mut failures: Vec<String> = Vec::new();
    for candidate in candidates {
        match prepare_workspace(&candidate) {
            Ok(()) => {
                return Writables {
                    chosen: Some(candidate),
                    failures,
                }
            },
            Err(err) => failures.push(format!("{} -> {err}", candidate.display())),
        }
    }
    Writables {
        chosen: None,
        failures,
    }
}

/// Create the directory and prove we can actually write to it.
fn prepare_workspace(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let probe = dir.join(".opencat-write-probe");
    std::fs::write(&probe, b"ok")?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// Build a path from an environment variable, for use before Tauri's own path
/// resolver is available.
fn env_dir(variable: &str, suffix: &[&str]) -> Option<PathBuf> {
    let mut path = PathBuf::from(std::env::var_os(variable)?);
    for part in suffix {
        path.push(part);
    }
    Some(path)
}

/// The directory holding the running executable.
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from))
}

/// Walk up from the executable looking for the project root (the directory that
/// holds `Cargo.toml`).
///
/// This only matters when every user-profile location is unwritable, which is
/// what happens inside a restricted development sandbox. The executable then
/// lives in `<project>/target/<profile>/`, and anchoring the fallback at the
/// project root rather than beside the executable keeps `cargo clean` from
/// deleting the user's saved connections.
fn project_root_from_exe() -> Option<PathBuf> {
    let mut dir = exe_dir()?;
    for _ in 0..4 {
        if dir.join("Cargo.toml").is_file() {
            return Some(dir);
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

/// Where to put data when the platform directories are unavailable.
fn fallback_root(leaf: &str) -> Option<PathBuf> {
    if let Some(root) = project_root_from_exe() {
        return Some(root.join(".opencat-data").join(leaf));
    }
    exe_dir().map(|dir| dir.join(".opencat-data").join(leaf))
}

/// WebView2 keeps its browser profile on disk and refuses to open a window when
/// it cannot write there. On a locked-down or redirected Windows profile the
/// default location fails with a bare "access denied", which surfaces as a setup
/// panic from inside Tauri — before any of our own code runs.
///
/// Returns the directory the caller should hand to
/// [`tauri::WebviewWindowBuilder::data_directory`]. Setting
/// `WEBVIEW2_USER_DATA_FOLDER` alone is not enough: Tauri passes an explicit
/// data directory to wry, and an explicit value wins over the environment.
fn configure_webview_profile() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
        let dir = PathBuf::from(explicit);
        eprintln!(
            "[opencat] webview profile (from environment): {}",
            dir.display()
        );
        return Some(dir);
    }

    // Ordered most-desirable first. The executable's own directory is last
    // because it is ugly, but it is also the one location we know is writable —
    // the build just wrote a binary there.
    let candidates = [
        env_dir("LOCALAPPDATA", &["opencat", "webview2"]),
        env_dir("APPDATA", &["opencat", "webview2"]),
        env_dir("USERPROFILE", &[".opencat", "webview2"]),
        env_dir("TEMP", &["opencat-webview2"]),
        fallback_root("webview2"),
    ]
    .into_iter()
    .flatten();

    let result = first_writable(candidates);
    match result.chosen {
        Some(dir) => {
            for failure in &result.failures {
                eprintln!("[opencat] webview profile candidate rejected: {failure}");
            }
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &dir);
            eprintln!("[opencat] webview profile: {}", dir.display());
            Some(dir)
        },
        None => {
            eprintln!("[opencat] no writable WebView2 profile location was found:");
            for failure in &result.failures {
                eprintln!("[opencat]   {failure}");
            }
            eprintln!(
                "[opencat] set WEBVIEW2_USER_DATA_FOLDER to a writable directory to override"
            );
            None
        },
    }
}

/// Resolve (and create) the directory that holds connections, settings, history
/// and snippets.
///
/// The platform app-data directory is the right answer almost always, but a
/// locked-down or redirected profile can make it unwritable. Rather than failing
/// to launch, fall back to a portable directory beside the executable.
fn workspace_dir(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    match app.path().app_data_dir() {
        Ok(dir) => candidates.push(dir.join(APP_DIR.to_ascii_lowercase()).join("workspace")),
        Err(err) => eprintln!("[opencat] app data directory unavailable: {err}"),
    }
    if let Ok(dir) = app.path().app_local_data_dir() {
        candidates.push(dir.join(APP_DIR.to_ascii_lowercase()).join("workspace"));
    }
    if let Some(home) = env_dir("USERPROFILE", &[".opencat", "workspace"]) {
        candidates.push(home);
    }
    if let Some(fallback) = fallback_root("workspace") {
        candidates.push(fallback);
    }
    candidates.push(
        std::env::temp_dir()
            .join(APP_DIR.to_ascii_lowercase())
            .join("workspace"),
    );

    let result = first_writable(candidates);
    match result.chosen {
        Some(dir) => {
            for failure in &result.failures {
                eprintln!("[opencat] workspace candidate rejected: {failure}");
            }
            eprintln!("[opencat] workspace: {}", dir.display());
            Ok(dir)
        },
        None => {
            let mut message =
                String::from("no writable location for the OpenCat workspace was found:");
            for failure in &result.failures {
                message.push_str("\n  ");
                message.push_str(failure);
            }
            Err(message.into())
        },
    }
}

/// Configure tracing. `OPENCAT_LOG` overrides the default filter, e.g.
/// `OPENCAT_LOG=opencat_driver=debug`.
fn init_tracing() {
    use tracing_subscriber::EnvFilter;

    let filter = EnvFilter::try_from_env("OPENCAT_LOG").unwrap_or_else(|_| {
        EnvFilter::new("opencat=info,opencat_driver=info,opencat_core=info,warn")
    });

    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .try_init();
}

/// Build and run the desktop application.
pub fn run() {
    init_tracing();
    let webview_data_dir = configure_webview_profile();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_os::init())
        .setup(move |app| {
            let dir = workspace_dir(app.handle())?;
            tracing::info!("OpenCat workspace: {}", dir.display());
            let state = AppState::new(&dir).map_err(|err| {
                Box::<dyn std::error::Error>::from(format!(
                    "could not open the OpenCat workspace at {}: {err}",
                    dir.display()
                ))
            })?;
            app.manage(state);

            // Tauri would create this window for us, but it forces the WebView2
            // profile into `app_local_data_dir()` and only warns when that path
            // is unusable — the `create_dir_all` that follows then aborts startup
            // with a bare "access denied". `create` is therefore `false` in
            // tauri.conf.json and we build the window here, reusing the config
            // but pointing WebView2 at a directory we have already proven
            // writable.
            if let Some(window_config) = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .cloned()
            {
                let mut builder =
                    tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?;
                if let Some(data_dir) = &webview_data_dir {
                    builder = builder.data_directory(data_dir.clone());
                }
                builder.build()?;
            } else {
                tracing::warn!("no `main` window is declared in tauri.conf.json");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // -- app ---------------------------------------------------------
            commands::app::app_info,
            commands::app::get_settings,
            commands::app::save_settings,
            commands::app::list_history,
            commands::app::clear_history,
            commands::app::delete_history,
            commands::app::list_snippets,
            commands::app::save_snippet,
            commands::app::delete_snippet,
            commands::app::read_text_file,
            commands::app::write_text_file,
            commands::app::path_exists,
            commands::app::reveal_workspace,
            commands::app::copy_to_clipboard,
            commands::app::read_clipboard,
            commands::app::focus_main_window,
            // -- connections -------------------------------------------------
            commands::connections::list_connections,
            commands::connections::save_connection,
            commands::connections::delete_connection,
            commands::connections::duplicate_connection,
            commands::connections::test_connection,
            commands::connections::validate_connection,
            commands::connections::open_connection,
            commands::connections::close_connection,
            commands::connections::list_sessions,
            commands::connections::ping_session,
            // -- explorer ----------------------------------------------------
            commands::explorer::list_databases,
            commands::explorer::list_schemas,
            commands::explorer::list_objects,
            commands::explorer::list_routines,
            commands::explorer::describe_table,
            commands::explorer::table_ddl,
            commands::explorer::summarise_scope,
            // -- query -------------------------------------------------------
            commands::query::execute_query,
            commands::query::explain_query,
            commands::query::count_statements,
            commands::query::classify_sql,
            // -- data grid ---------------------------------------------------
            commands::data::fetch_page,
            commands::data::count_rows,
            commands::data::find_rows,
            commands::data::update_row,
            commands::data::insert_row,
            commands::data::delete_row,
            commands::data::duplicate_row,
            commands::data::collect_rows,
            // -- schema ------------------------------------------------------
            commands::schema::preview_create_table,
            commands::schema::preview_alter_table,
            commands::schema::preview_drop_object,
            commands::schema::apply_script,
            commands::schema::create_table,
            commands::schema::alter_table,
            commands::schema::rename_object,
            commands::schema::drop_object,
            commands::schema::truncate_table,
            commands::schema::create_database,
            commands::schema::drop_database,
            // -- import / export ---------------------------------------------
            commands::transfer::export_data,
            commands::transfer::preview_import,
            commands::transfer::import_data,
            commands::transfer::detect_import_format,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the OpenCat application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Close every pool so the server sees an orderly disconnect.
            if let Some(state) = app_handle.try_state::<AppState>() {
                tauri::async_runtime::block_on(state.close_all());
            }
        }
    });
}
