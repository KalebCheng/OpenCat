//! The on-disk workspace: connection profiles, settings, history and snippets.
//!
//! Everything lives in a single directory (the Tauri app-data directory in the
//! packaged app), stored as pretty-printed JSON so users can diff, back up or
//! hand-edit it. Writes go through a temp-file + rename so a crash can never
//! leave a truncated store behind.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use crate::error::{CoreError, Result};
use crate::model::ConnectionProfile;
use crate::secrets::SecretStore;
use crate::settings::{AppSettings, HistoryEntry, SavedQuery};

const CONNECTIONS_FILE: &str = "connections.json";
const SETTINGS_FILE: &str = "settings.json";
const HISTORY_FILE: &str = "history.json";
const SNIPPETS_FILE: &str = "snippets.json";

/// Owns the persisted state of the application.
#[derive(Debug)]
pub struct Workspace {
    dir: PathBuf,
    secrets: SecretStore,
    connections: Vec<ConnectionProfile>,
    settings: AppSettings,
    history: VecDeque<HistoryEntry>,
    snippets: Vec<SavedQuery>,
}

impl Workspace {
    /// Open (and create if needed) the workspace rooted at `dir`.
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&dir)?;
        let secrets = SecretStore::load_or_create(&dir)?;

        let mut ws = Workspace {
            connections: read_json(&dir.join(CONNECTIONS_FILE))?.unwrap_or_default(),
            settings: read_json(&dir.join(SETTINGS_FILE))?.unwrap_or_default(),
            history: read_json::<Vec<HistoryEntry>>(&dir.join(HISTORY_FILE))?
                .unwrap_or_default()
                .into(),
            snippets: read_json(&dir.join(SNIPPETS_FILE))?.unwrap_or_default(),
            dir,
            secrets,
        };
        for profile in &mut ws.connections {
            profile.normalise();
        }
        ws.trim_history();
        Ok(ws)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn secrets(&self) -> &SecretStore {
        &self.secrets
    }

    // -- connections ---------------------------------------------------------

    /// Profiles with secrets masked, ready to be sent to the UI.
    pub fn connections_masked(&self) -> Vec<ConnectionProfile> {
        self.connections.iter().map(|p| p.redacted()).collect()
    }

    /// Profiles with decrypted secrets, ready to open a connection with.
    pub fn connections_resolved(&self) -> Vec<ConnectionProfile> {
        self.connections
            .iter()
            .filter_map(|p| self.resolve(p).ok())
            .collect()
    }

    /// Decrypt a single profile in place.
    pub fn resolve(&self, profile: &ConnectionProfile) -> Result<ConnectionProfile> {
        let mut out = profile.clone();
        out.password = self.secrets.decrypt(&profile.password)?;
        out.ssh.password = self.secrets.decrypt(&profile.ssh.password)?;
        out.ssh.passphrase = match &profile.ssh.passphrase {
            Some(p) => self.secrets.decrypt(p).map(Some)?,
            None => None,
        };
        Ok(out)
    }

    pub fn connection(&self, id: &str) -> Option<&ConnectionProfile> {
        self.connections.iter().find(|p| p.id == id)
    }

    /// Insert or update a profile. Secrets arriving as the mask sentinel are
    /// restored from the stored copy; new secrets are encrypted before writing.
    pub fn upsert_connection(
        &mut self,
        mut incoming: ConnectionProfile,
    ) -> Result<ConnectionProfile> {
        incoming.normalise();
        if let Some(existing) = self.connections.iter().find(|p| p.id == incoming.id) {
            incoming.merge_secrets(existing);
            incoming.created_at = existing.created_at.clone();
        }
        incoming.updated_at = Some(chrono::Utc::now().to_rfc3339());

        let stored = ConnectionProfile {
            password: self.secrets.encrypt(&incoming.password)?,
            ssh: crate::model::SshTunnel {
                password: self.secrets.encrypt(&incoming.ssh.password)?,
                passphrase: match &incoming.ssh.passphrase {
                    Some(p) => Some(self.secrets.encrypt(p)?),
                    None => None,
                },
                ..incoming.ssh.clone()
            },
            ..incoming.clone()
        };

        match self.connections.iter_mut().find(|p| p.id == stored.id) {
            Some(slot) => *slot = stored,
            None => self.connections.push(stored),
        }
        self.persist_connections()?;
        Ok(incoming.redacted())
    }

    pub fn delete_connection(&mut self, id: &str) -> Result<bool> {
        let before = self.connections.len();
        self.connections.retain(|p| p.id != id);
        let removed = self.connections.len() != before;
        if removed {
            self.persist_connections()?;
        }
        Ok(removed)
    }

    /// Duplicate a profile under a new id and name.
    pub fn duplicate_connection(
        &mut self,
        id: &str,
        new_name: Option<String>,
    ) -> Result<ConnectionProfile> {
        let source = self
            .connection(id)
            .cloned()
            .ok_or_else(|| CoreError::NotFound(format!("connection `{id}`")))?;
        let mut copy = source;
        copy.id = uuid::Uuid::new_v4().to_string();
        copy.name = new_name.unwrap_or_else(|| format!("{} copy", copy.name));
        copy.created_at = Some(chrono::Utc::now().to_rfc3339());
        copy.updated_at = None;
        let stored = copy.clone();
        self.connections.push(stored);
        self.persist_connections()?;
        Ok(copy.redacted())
    }

    fn persist_connections(&self) -> Result<()> {
        write_json(&self.dir.join(CONNECTIONS_FILE), &self.connections)
    }

    // -- settings ------------------------------------------------------------

    pub fn settings(&self) -> &AppSettings {
        &self.settings
    }

    pub fn set_settings(&mut self, settings: AppSettings) -> Result<AppSettings> {
        self.settings = settings;
        write_json(&self.dir.join(SETTINGS_FILE), &self.settings)?;
        Ok(self.settings.clone())
    }

    // -- history -------------------------------------------------------------

    pub fn history(&self) -> Vec<HistoryEntry> {
        self.history.iter().cloned().collect()
    }

    /// Restore the history list, e.g. from disk on first access.
    pub fn set_history(&mut self, entries: Vec<HistoryEntry>) -> Result<()> {
        self.history = entries.into();
        self.trim_history();
        self.persist_history()
    }

    pub fn push_history(&mut self, entry: HistoryEntry) -> Result<()> {
        if !self.settings.save_query_history {
            return Ok(());
        }
        self.history.push_front(entry);
        self.trim_history();
        self.persist_history()
    }

    pub fn clear_history(&mut self) -> Result<()> {
        self.history.clear();
        self.persist_history()
    }

    pub fn delete_history(&mut self, id: &str) -> Result<()> {
        self.history.retain(|h| h.id != id);
        self.persist_history()
    }

    fn trim_history(&mut self) {
        let limit = self.settings.history_limit.max(10) as usize;
        while self.history.len() > limit {
            self.history.pop_back();
        }
    }

    fn persist_history(&self) -> Result<()> {
        let slice: Vec<&HistoryEntry> = self.history.iter().collect();
        write_json(&self.dir.join(HISTORY_FILE), &slice)
    }

    // -- snippets ------------------------------------------------------------

    pub fn snippets(&self) -> Vec<SavedQuery> {
        self.snippets.clone()
    }

    pub fn upsert_snippet(&mut self, mut query: SavedQuery) -> Result<SavedQuery> {
        query.updated_at = chrono::Utc::now().to_rfc3339();
        match self.snippets.iter_mut().find(|s| s.id == query.id) {
            Some(slot) => *slot = query.clone(),
            None => self.snippets.push(query.clone()),
        }
        write_json(&self.dir.join(SNIPPETS_FILE), &self.snippets)?;
        Ok(query)
    }

    pub fn delete_snippet(&mut self, id: &str) -> Result<()> {
        self.snippets.retain(|s| s.id != id);
        write_json(&self.dir.join(SNIPPETS_FILE), &self.snippets)
    }
}

/// Read JSON, returning `None` when the file does not exist.
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path)?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| CoreError::Config(format!("{}: {e}", path.display())))
}

/// Atomically write pretty JSON.
fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(value)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text.as_bytes())?;
    // On Windows `rename` fails when the destination exists.
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DbKind;

    fn tempdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("opencat-ws-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn persists_and_reloads_connections() {
        let dir = tempdir("conn");
        {
            let mut ws = Workspace::open(&dir).unwrap();
            let mut profile = ConnectionProfile::new("local pg", DbKind::Postgres);
            profile.password = "s3cret".into();
            ws.upsert_connection(profile).unwrap();
        }
        let ws = Workspace::open(&dir).unwrap();
        let masked = ws.connections_masked();
        assert_eq!(masked.len(), 1);
        assert_eq!(masked[0].password, crate::model::MASK);
        let resolved = ws.connections_resolved();
        assert_eq!(resolved[0].password, "s3cret");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn masked_secret_is_preserved_on_update() {
        let dir = tempdir("mask");
        let mut ws = Workspace::open(&dir).unwrap();
        let mut profile = ConnectionProfile::new("pg", DbKind::Postgres);
        profile.password = "keep-me".into();
        let saved = ws.upsert_connection(profile).unwrap();

        let mut edited = saved.clone();
        edited.name = "renamed".into();
        ws.upsert_connection(edited).unwrap();

        let resolved = ws.connections_resolved();
        assert_eq!(resolved[0].password, "keep-me");
        assert_eq!(resolved[0].name, "renamed");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn history_is_capped_and_newest_first() {
        let dir = tempdir("hist");
        let mut ws = Workspace::open(&dir).unwrap();
        let mut settings = ws.settings().clone();
        settings.history_limit = 10;
        ws.set_settings(settings).unwrap();
        for i in 0..25 {
            ws.push_history(HistoryEntry::new("p", format!("SELECT {i}")))
                .unwrap();
        }
        let history = ws.history();
        assert_eq!(history.len(), 10);
        assert_eq!(history[0].sql, "SELECT 24");
        std::fs::remove_dir_all(&dir).ok();
    }
}
