//! # opencat-driver
//!
//! A uniform async interface over the databases OpenCat supports.
//!
//! Every engine implements [`traits::Driver`]. The rest of the application never
//! sees a `sqlx` type: it asks for an object list, a table description, a page of
//! rows or a schema edit, and gets back the engine-agnostic structures defined in
//! `opencat-core`.
//!
//! ```no_run
//! # async fn demo() -> opencat_core::Result<()> {
//! use opencat_core::model::{ConnectionProfile, DbKind};
//! use opencat_driver::{connect, QueryOptions};
//!
//! let mut profile = ConnectionProfile::new("local", DbKind::Sqlite);
//! profile.file = Some("./demo.db".into());
//!
//! let driver = connect(&profile).await?;
//! let results = driver.execute("SELECT 1", &QueryOptions::default()).await?;
//! println!("{} result sets", results.len());
//! driver.close().await;
//! # Ok(())
//! # }
//! ```

pub mod common;
pub mod ddl;
pub mod edit;
pub mod mysql;
pub mod postgres;
pub mod sqlite;
pub mod traits;
pub mod transfer;

pub use traits::{
    classify_error, CountRequest, Driver, DriverConfig, FindRequest, OrderBy, PageRequest,
    QueryOptions, Scope, SharedDriver,
};

use opencat_core::model::{ConnectionProfile, DbKind};
use opencat_core::{CoreError, Result};

/// Open a connection for `profile`.
///
/// Secrets must already be decrypted — pass a profile obtained from
/// [`opencat_core::Workspace::connections_resolved`].
pub async fn connect(profile: &ConnectionProfile) -> Result<SharedDriver> {
    connect_with(DriverConfig::new(profile.clone())).await
}

/// Open a connection with explicit driver configuration (pool size, endpoint
/// override for SSH tunnels, ...).
pub async fn connect_with(cfg: DriverConfig) -> Result<SharedDriver> {
    let driver: SharedDriver = match cfg.profile.kind {
        DbKind::Sqlite => std::sync::Arc::new(sqlite::SqliteDriver::connect(&cfg).await?),
        DbKind::Mysql => std::sync::Arc::new(mysql::MySqlDriver::connect(&cfg).await?),
        DbKind::Postgres => std::sync::Arc::new(postgres::PostgresDriver::connect(&cfg).await?),
    };
    Ok(driver)
}

/// Probe a profile without keeping the connection: used by "Test Connection".
///
/// Returns the server banner so the UI can confirm *which* server answered.
pub async fn test_connection(
    profile: &ConnectionProfile,
) -> Result<opencat_core::model::ServerInfo> {
    if profile.kind == DbKind::Sqlite {
        let file = profile
            .file
            .clone()
            .filter(|f| !f.trim().is_empty())
            .ok_or_else(|| CoreError::Config("no SQLite database file was specified".into()))?;
        if !std::path::Path::new(&file).exists() {
            return Err(CoreError::Connection(format!(
                "SQLite database `{file}` does not exist"
            )));
        }
    }

    let driver = connect(profile).await?;
    let info = driver.server_info().await;
    driver.close().await;
    info
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sqlite_smoke_test() {
        let dir = std::env::temp_dir().join(format!("opencat-drv-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("smoke.db");
        {
            let opts = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&file)
                .create_if_missing(true);
            let pool = sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(opts)
                .await
                .unwrap();
            sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL, blob_col BLOB, flag BOOLEAN, made_at DATETIME)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO t (name, score, blob_col, flag, made_at) VALUES ('a', 1.5, X'01ff', 1, '2024-05-01 10:00:00')")
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
        }

        let mut profile = ConnectionProfile::new("smoke", DbKind::Sqlite);
        profile.file = Some(file.to_string_lossy().to_string());
        let driver = connect(&profile).await.unwrap();

        let info = driver.server_info().await.unwrap();
        assert!(info.version.starts_with("3."), "{}", info.version);

        let objects = driver.list_objects(&Scope::database("main")).await.unwrap();
        assert_eq!(objects.len(), 1);
        assert_eq!(objects[0].name, "t");

        let results = driver
            .execute("SELECT * FROM t", &QueryOptions::default())
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].rows.len(), 1);

        let page = driver
            .fetch_page(&PageRequest {
                scope: Scope::database("main"),
                table: "t".into(),
                offset: 0,
                limit: 10,
                order_by: vec![],
                filter: None,
                include_total: true,
            })
            .await
            .unwrap();
        assert!(page.editable);
        assert_eq!(page.total_rows, Some(1));
        assert_eq!(page.key_columns, vec!["id".to_string()]);

        driver.close().await;
        std::fs::remove_dir_all(&dir).ok();
    }
}
