//! End-to-end exercise of the whole backend against a real SQLite file.
//!
//! This is the test that would catch a regression in any layer: connection
//! handling, DDL execution, typed cell decoding, the data-grid page contract,
//! identity-based row edits and the import/export pipeline. MySQL and PostgreSQL
//! need a server, so those drivers are exercised by their unit tests instead 鈥?//! everything below the wire format is shared.

use std::collections::BTreeMap;

use opencat_core::model::{CellChange, ConnectionProfile, DbKind, ObjectKind, RowEdit, RowInsert};
use opencat_core::value::Value;
use opencat_driver::transfer::{self, CsvOptions, ExportRequest, ImportOptions, TransferFormat};
use opencat_driver::{connect, CountRequest, PageRequest, QueryOptions, Scope};

/// A scratch directory that cleans itself up.
struct Scratch(std::path::PathBuf);

impl Scratch {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "opencat-e2e-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        Scratch(dir)
    }

    fn join(&self, name: &str) -> std::path::PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Build a profile that creates the database file on first connect.
fn sqlite_profile(path: &std::path::Path) -> ConnectionProfile {
    let mut profile = ConnectionProfile::new("e2e", DbKind::Sqlite);
    profile.file = Some(path.to_string_lossy().to_string());
    profile.params.insert("create".into(), "true".into());
    profile.max_rows = 1_000;
    profile
}

#[tokio::test]
async fn full_lifecycle_against_sqlite() {
    let scratch = Scratch::new("lifecycle");
    let db_path = scratch.join("app.db");
    let profile = sqlite_profile(&db_path);

    let driver = connect(&profile).await.expect("connect");

    // --- server info --------------------------------------------------------
    let info = driver.server_info().await.expect("server_info");
    assert!(
        info.version.starts_with("3."),
        "unexpected version: {}",
        info.version
    );

    // --- DDL ----------------------------------------------------------------
    let results = driver
        .execute(
            "CREATE TABLE users (\n\
               id INTEGER PRIMARY KEY AUTOINCREMENT,\n\
               name TEXT NOT NULL,\n\
               email TEXT UNIQUE,\n\
               score REAL,\n\
               active BOOLEAN DEFAULT 1,\n\
               created_at DATETIME\n\
             );\n\
             CREATE INDEX idx_users_name ON users (name);",
            &QueryOptions::default(),
        )
        .await
        .expect("create table");
    assert_eq!(results.len(), 2, "one result per statement");

    let objects = driver
        .list_objects(&Scope::database("main"))
        .await
        .expect("list objects");
    assert!(objects
        .iter()
        .any(|o| o.name == "users" && o.kind == ObjectKind::Table));

    // --- schema introspection ----------------------------------------------
    let schema = driver
        .table_schema(&Scope::database("main"), "users", ObjectKind::Table)
        .await
        .expect("describe");
    assert_eq!(schema.columns.len(), 6);
    let id = schema
        .columns
        .iter()
        .find(|c| c.name == "id")
        .expect("id column");
    assert!(id.is_primary_key);
    assert!(id.is_auto_increment);
    assert!(!id.nullable);
    assert!(schema.indexes.iter().any(|i| i.name == "idx_users_name"));

    let ddl = driver
        .table_ddl(&Scope::database("main"), "users", ObjectKind::Table)
        .await
        .expect("ddl");
    assert!(ddl.to_uppercase().contains("CREATE TABLE"));

    // --- typed inserts ------------------------------------------------------
    let mut values = BTreeMap::new();
    values.insert("name".to_string(), Value::Text("Ada".into()));
    values.insert("email".to_string(), Value::Text("ada@example.com".into()));
    values.insert("score".to_string(), Value::Float(9.5));
    values.insert("active".to_string(), Value::Bool(true));
    values.insert(
        "created_at".to_string(),
        Value::DateTime("2024-05-01 10:00:00".into()),
    );
    assert_eq!(
        driver
            .insert_row(&RowInsert {
                database: Some("main".into()),
                schema: None,
                table: "users".into(),
                values: values.clone(),
            })
            .await
            .expect("insert"),
        1
    );

    values.insert("name".to_string(), Value::Text("Grace".into()));
    values.insert("email".to_string(), Value::Text("grace@example.com".into()));
    values.insert("score".to_string(), Value::Float(8.25));
    assert_eq!(
        driver
            .insert_row(&RowInsert {
                database: Some("main".into()),
                schema: None,
                table: "users".into(),
                values,
            })
            .await
            .expect("insert 2"),
        1
    );

    // --- paged read ---------------------------------------------------------
    let scope = Scope::database("main");
    let page = driver
        .fetch_page(&PageRequest {
            scope: scope.clone(),
            table: "users".into(),
            offset: 0,
            limit: 10,
            order_by: vec![],
            filter: None,
            include_total: true,
        })
        .await
        .expect("fetch page");

    assert!(page.editable, "reason: {:?}", page.reason);
    assert_eq!(page.key_columns, vec!["id".to_string()]);
    assert_eq!(page.total_rows, Some(2));
    assert_eq!(page.rows.len(), 2);

    let name_index = page
        .columns
        .iter()
        .position(|c| c.name == "name")
        .expect("name column");
    let score_index = page
        .columns
        .iter()
        .position(|c| c.name == "score")
        .expect("score column");
    let id_index = page
        .columns
        .iter()
        .position(|c| c.name == "id")
        .expect("id column");

    // The decoder must give us types, not strings.
    assert!(matches!(page.rows[0][name_index], Value::Text(_)));
    assert!(matches!(page.rows[0][score_index], Value::Float(_)));
    assert!(matches!(page.rows[0][id_index], Value::Int(_)));

    // Column metadata carries what the insert dialog needs.
    let id_meta = &page.columns[id_index];
    assert!(id_meta.is_auto_increment);
    assert!(id_meta.is_primary_key);

    // --- identity-based update ---------------------------------------------
    let target_id = match page.rows[0][id_index] {
        Value::Int(v) => v,
        ref other => panic!("expected an integer id, got {other:?}"),
    };
    let mut keys = BTreeMap::new();
    keys.insert("id".to_string(), Value::Int(target_id));

    let affected = driver
        .update_row(&RowEdit {
            database: Some("main".into()),
            schema: None,
            table: "users".into(),
            keys: keys.clone(),
            changes: vec![CellChange {
                column: "score".into(),
                old_value: page.rows[0][score_index].clone(),
                new_value: Value::Float(10.0),
            }],
        })
        .await
        .expect("update");
    assert_eq!(affected, 1);

    // A stale old value must not match anything, which is the lost-update guard.
    let stale = driver
        .update_row(&RowEdit {
            database: Some("main".into()),
            schema: None,
            table: "users".into(),
            keys: keys.clone(),
            changes: vec![CellChange {
                column: "score".into(),
                old_value: Value::Float(9.5),
                new_value: Value::Float(1.0),
            }],
        })
        .await
        .expect("stale update");
    assert_eq!(stale, 0, "a stale guard must not overwrite");

    // --- counts and search --------------------------------------------------
    let count = driver
        .count_rows(&CountRequest {
            scope: scope.clone(),
            table: "users".into(),
            filter: Some("name = 'Ada'".into()),
            approximate: false,
        })
        .await
        .expect("count");
    assert_eq!(count, 1);

    let found = driver
        .find_rows(&opencat_driver::FindRequest {
            scope: scope.clone(),
            table: "users".into(),
            columns: vec!["name".into()],
            needle: "grace".into(),
            limit: 10,
        })
        .await
        .expect("find");
    assert_eq!(
        found.rows.len(),
        1,
        "case-insensitive search should match Grace"
    );

    // --- export -------------------------------------------------------------
    // `id` is a surrogate key and `email` is UNIQUE, so a realistic round trip
    // exports the other columns and lets the engine assign fresh values.
    let email_index = page
        .columns
        .iter()
        .position(|c| c.name == "email")
        .expect("email column");
    let round_trip_columns: Vec<String> = page
        .columns
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != id_index && *index != email_index)
        .map(|(_, c)| c.name.clone())
        .collect();
    let round_trip_rows: Vec<Vec<Value>> = page
        .rows
        .iter()
        .map(|row| {
            row.iter()
                .enumerate()
                .filter(|(index, _)| *index != id_index && *index != email_index)
                .map(|(_, value)| value.clone())
                .collect()
        })
        .collect();

    let csv_path = scratch.join("users.csv");
    let summary = transfer::export(&ExportRequest {
        format: TransferFormat::Csv,
        path: csv_path.to_string_lossy().to_string(),
        columns: round_trip_columns.clone(),
        rows: round_trip_rows.clone(),
        table: Some("users".into()),
        database: Some("main".into()),
        schema: None,
        db_kind: DbKind::Sqlite,
        csv: CsvOptions::default(),
        create_table: None,
        batch_size: 100,
    })
    .expect("export csv");
    assert_eq!(summary.rows, 2);
    assert!(summary.bytes > 0);

    let csv_text = std::fs::read_to_string(&csv_path).expect("read csv");
    assert!(csv_text.contains("Ada"), "csv was: {csv_text}");
    assert!(
        csv_text.contains("score"),
        "the header should be present: {csv_text}"
    );

    // --- import round trip --------------------------------------------------
    let parsed = transfer::parse_file(&csv_path.to_string_lossy(), &ImportOptions::default())
        .expect("parse csv");
    assert_eq!(parsed.format, TransferFormat::Csv);
    assert_eq!(parsed.columns, round_trip_columns);
    assert_eq!(parsed.rows.len(), 2);

    let inserts = transfer::rows_to_inserts(
        "users",
        Some("main"),
        None,
        &parsed.columns,
        &parsed.rows,
        DbKind::Sqlite,
        100,
    );
    assert_eq!(inserts.len(), 1, "two rows should batch into one statement");
    driver
        .execute(&inserts[0], &QueryOptions::default())
        .await
        .expect("re-insert exported rows");

    let after = driver
        .count_rows(&CountRequest {
            scope: scope.clone(),
            table: "users".into(),
            filter: None,
            approximate: false,
        })
        .await
        .expect("count after import");
    assert_eq!(after, 4, "import should have added two more rows");

    // --- SQL insert export --------------------------------------------------
    let sql_path = scratch.join("users.sql");
    transfer::export(&ExportRequest {
        format: TransferFormat::SqlInsert,
        path: sql_path.to_string_lossy().to_string(),
        columns: page.columns.iter().map(|c| c.name.clone()).collect(),
        rows: page.rows.clone(),
        table: Some("users".into()),
        database: Some("main".into()),
        schema: None,
        db_kind: DbKind::Sqlite,
        csv: CsvOptions::default(),
        create_table: Some(ddl.clone()),
        batch_size: 1,
    })
    .expect("export sql");
    let sql_text = std::fs::read_to_string(&sql_path).expect("read sql");
    assert!(sql_text.contains("INSERT INTO"), "sql was: {sql_text}");

    // --- JSON export --------------------------------------------------------
    let json_path = scratch.join("users.json");
    transfer::export(&ExportRequest {
        format: TransferFormat::Json,
        path: json_path.to_string_lossy().to_string(),
        columns: page.columns.iter().map(|c| c.name.clone()).collect(),
        rows: page.rows.clone(),
        table: Some("users".into()),
        database: Some("main".into()),
        schema: None,
        db_kind: DbKind::Sqlite,
        csv: CsvOptions::default(),
        create_table: None,
        batch_size: 100,
    })
    .expect("export json");
    let json_text = std::fs::read_to_string(&json_path).expect("read json");
    let parsed_json: serde_json::Value = serde_json::from_str(&json_text).expect("valid json");
    assert!(parsed_json.is_array());

    // --- delete -------------------------------------------------------------
    let deleted = driver
        .delete_row(&RowEdit {
            database: Some("main".into()),
            schema: None,
            table: "users".into(),
            keys: keys.clone(),
            changes: vec![],
        })
        .await
        .expect("delete");
    assert_eq!(deleted, 1);

    assert_eq!(
        driver
            .count_rows(&CountRequest {
                scope: scope.clone(),
                table: "users".into(),
                filter: None,
                approximate: false,
            })
            .await
            .expect("final count"),
        3
    );

    // --- read-only guard ----------------------------------------------------
    let safe = driver
        .execute(
            "SELECT 1",
            &QueryOptions {
                read_only: true,
                ..Default::default()
            },
        )
        .await
        .expect("read-only select is allowed");
    assert_eq!(safe.len(), 1);

    let refused = driver
        .execute(
            "DELETE FROM users",
            &QueryOptions {
                read_only: true,
                ..Default::default()
            },
        )
        .await;
    assert!(refused.is_err(), "a read-only session must refuse writes");

    // --- object lifecycle ---------------------------------------------------
    driver
        .rename_object(&scope, "users", "people", ObjectKind::Table)
        .await
        .expect("rename");
    let renamed = driver
        .list_objects(&scope)
        .await
        .expect("list after rename");
    assert!(renamed.iter().any(|o| o.name == "people"));

    driver
        .truncate_table(&scope, "people")
        .await
        .expect("truncate");
    assert_eq!(
        driver
            .count_rows(&CountRequest {
                scope: scope.clone(),
                table: "people".into(),
                filter: None,
                approximate: false,
            })
            .await
            .expect("count after truncate"),
        0
    );

    driver
        .drop_object(&scope, "people", ObjectKind::Table)
        .await
        .expect("drop");
    assert!(driver
        .list_objects(&scope)
        .await
        .expect("list after drop")
        .is_empty());

    driver.ping().await.expect("ping");
    driver.close().await;
}

#[tokio::test]
async fn the_bundled_sample_database_introspects_cleanly() {
    // `examples/demo.db` ships with the repository so a first run has something
    // to browse. Keeping a test on it means a broken sample is caught here
    // rather than by a user opening the app.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/demo.db");
    if !path.exists() {
        eprintln!("skipping: {} is not present", path.display());
        return;
    }

    let mut profile = ConnectionProfile::new("demo", DbKind::Sqlite);
    profile.file = Some(path.to_string_lossy().to_string());
    let driver = connect(&profile).await.expect("open the sample database");

    let scope = Scope::database("main");
    let objects = driver.list_objects(&scope).await.expect("list objects");
    let names: Vec<&str> = objects.iter().map(|o| o.name.as_str()).collect();
    for expected in [
        "customers",
        "products",
        "orders",
        "order_items",
        "order_summary",
    ] {
        assert!(names.contains(&expected), "missing {expected} in {names:?}");
    }

    let schema = driver
        .table_schema(&scope, "customers", ObjectKind::Table)
        .await
        .expect("describe customers");
    assert_eq!(schema.primary_key_columns(), vec!["id".to_string()]);
    // The sample deliberately has a nullable column so the grid shows NULLs.
    let credit = schema
        .columns
        .iter()
        .find(|c| c.name == "credit")
        .expect("credit column");
    assert!(credit.nullable);

    let page = driver
        .fetch_page(&PageRequest {
            scope: scope.clone(),
            table: "customers".into(),
            offset: 0,
            limit: 50,
            order_by: vec![],
            filter: None,
            include_total: true,
        })
        .await
        .expect("page through customers");
    assert_eq!(page.rows.len(), 50);
    assert_eq!(page.total_rows, Some(120));
    assert!(page.editable);

    // The view must be readable even though it is not editable.
    let view_page = driver
        .fetch_page(&PageRequest {
            scope: scope.clone(),
            table: "order_summary".into(),
            offset: 0,
            limit: 5,
            order_by: vec![],
            filter: None,
            include_total: false,
        })
        .await
        .expect("page through the view");
    assert_eq!(view_page.rows.len(), 5);

    driver.close().await;
}

#[tokio::test]
async fn rejects_a_missing_database_file() {
    let mut profile = ConnectionProfile::new("missing", DbKind::Sqlite);
    profile.file = Some("C:/definitely/not/here/opencat.db".into());
    // Connecting must fail rather than silently creating the file.
    let error = connect(&profile).await.err().expect("should not connect");
    assert!(
        error.to_string().contains("does not exist"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn read_only_mode_refuses_writes_and_mutations() {
    let scratch = Scratch::new("readonly");
    let db_path = scratch.join("ro.db");

    // Create the file and a table through a normal connection first.
    {
        let driver = connect(&sqlite_profile(&db_path))
            .await
            .expect("seed connect");
        driver
            .execute(
                "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)",
                &QueryOptions::default(),
            )
            .await
            .expect("seed table");
        driver.close().await;
    }

    let mut profile = ConnectionProfile::new("ro", DbKind::Sqlite);
    profile.file = Some(db_path.to_string_lossy().to_string());
    profile.params.insert("mode".into(), "ro".into());
    let driver = connect(&profile).await.expect("read-only connect");

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
        .expect("read works");
    assert!(!page.editable, "a read-only session must not offer editing");
    assert!(page.reason.is_some());

    let mut values = BTreeMap::new();
    values.insert("v".to_string(), Value::Text("x".into()));
    let refusal = driver
        .insert_row(&RowInsert {
            database: Some("main".into()),
            schema: None,
            table: "t".into(),
            values,
        })
        .await;
    assert!(refusal.is_err(), "reads must not be possible either way");

    driver.close().await;
}
