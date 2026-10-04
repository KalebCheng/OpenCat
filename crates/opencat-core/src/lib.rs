//! # opencat-core
//!
//! Engine-agnostic foundations shared by the OpenCat desktop shell and every
//! database driver:
//!
//! * [`model`] — connection profiles, schema objects, query results (the IPC contract)
//! * [`value`] — typed cell values with a JSON projection for the data grid
//! * [`sql`] — dialect-aware quoting, statement splitting and classification
//! * [`workspace`] — JSON persistence for connections, settings, history and snippets
//! * [`secrets`] — AES-256-GCM encryption of stored passwords
//! * [`error`] — a single error type that serializes cleanly across IPC

pub mod error;
pub mod model;
pub mod secrets;
pub mod settings;
pub mod sql;
pub mod value;
pub mod workspace;

pub use error::{CoreError, ErrorPayload, Result};
pub use model::*;
pub use settings::{AppSettings, HistoryEntry, SavedQuery, Theme};
pub use value::{Value, ValueKind};
pub use workspace::Workspace;

/// The product name, used in window titles, user-agent strings and the app data
/// directory.
pub const APP_NAME: &str = "OpenCat";

/// Semantic version of the core crate.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The directory name used under the platform's app-data root.
pub const APP_DIR: &str = "OpenCat";

/// Reserved schema names that should be hidden unless "show system objects" is on.
pub fn is_system_schema(kind: DbKind, name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    match kind {
        DbKind::Sqlite => lower.starts_with("sqlite_"),
        DbKind::Mysql => matches!(
            lower.as_str(),
            "information_schema" | "performance_schema" | "mysql" | "sys"
        ),
        DbKind::Postgres => {
            matches!(
                lower.as_str(),
                "pg_catalog" | "information_schema" | "pg_toast"
            ) || lower.starts_with("pg_temp")
                || lower.starts_with("pg_toast_temp")
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_system_schemas() {
        assert!(is_system_schema(DbKind::Mysql, "information_schema"));
        assert!(is_system_schema(DbKind::Postgres, "PG_CATALOG"));
        assert!(is_system_schema(DbKind::Sqlite, "sqlite_master"));
        assert!(!is_system_schema(DbKind::Postgres, "public"));
    }

    #[test]
    fn db_kind_metadata_is_consistent() {
        for kind in DbKind::ALL {
            assert!(!kind.display_name().is_empty());
            assert!(!kind.placeholder(1).is_empty());
            assert!(!kind.as_str().is_empty());
        }
        assert_eq!(DbKind::Postgres.placeholder(3), "$3");
        assert_eq!(DbKind::Mysql.placeholder(3), "?");
    }
}
