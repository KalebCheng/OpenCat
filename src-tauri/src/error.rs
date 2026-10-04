//! Command-layer error handling.
//!
//! Tauri commands return a serializable payload instead of leaking Rust types to
//! JavaScript. The payload carries a stable machine-readable `code` so the
//! frontend can pick an icon and decide whether the message deserves a toast or
//! a modal.
//!
//! [`CmdError`] is a local newtype rather than a bare [`ErrorPayload`] because
//! the orphan rule forbids implementing `From<CoreError>` for a type owned by
//! another crate. It is `#[serde(transparent)]`, so the frontend still sees a
//! plain `{ code, message, detail }` object.

use opencat_core::{CoreError, ErrorPayload};

/// The error type every command returns.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(transparent)]
pub struct CmdError(pub ErrorPayload);

impl CmdError {
    /// Stable machine-readable code, e.g. `query` or `not_found`.
    pub fn code(&self) -> &str {
        &self.0.code
    }

    /// Human-readable message.
    pub fn message(&self) -> &str {
        &self.0.message
    }
}

impl std::fmt::Display for CmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0.message)
    }
}

impl std::error::Error for CmdError {}

/// Every command returns this.
pub type CmdResult<T> = std::result::Result<T, CmdError>;

/// Wrap an arbitrary message.
pub fn other(message: impl Into<String>) -> CmdError {
    CmdError(ErrorPayload {
        code: "other".into(),
        message: message.into(),
        detail: None,
    })
}

/// Wrap a message under a specific code.
pub fn coded(code: &str, message: impl Into<String>) -> CmdError {
    CmdError(ErrorPayload {
        code: code.into(),
        message: message.into(),
        detail: None,
    })
}

impl From<ErrorPayload> for CmdError {
    fn from(payload: ErrorPayload) -> Self {
        CmdError(payload)
    }
}

impl From<CoreError> for CmdError {
    fn from(err: CoreError) -> Self {
        CmdError(ErrorPayload::from(&err))
    }
}

impl From<std::io::Error> for CmdError {
    fn from(err: std::io::Error) -> Self {
        coded("io", format!("i/o error: {err}"))
    }
}

impl From<serde_json::Error> for CmdError {
    fn from(err: serde_json::Error) -> Self {
        coded("serde", format!("serialization error: {err}"))
    }
}

impl From<tauri::Error> for CmdError {
    fn from(err: tauri::Error) -> Self {
        coded("tauri", err.to_string())
    }
}
