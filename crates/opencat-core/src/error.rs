//! Error types shared by every OpenCat crate.
//!
//! The error enum is deliberately transport friendly: [`CoreError`] serializes
//! through [`ErrorPayload`], a plain struct that can cross the Tauri IPC boundary
//! without leaking internal representations. The variant is available to the
//! frontend as [`ErrorPayload::code`], and long messages are mirrored into
//! [`ErrorPayload::detail`] so the UI can offer a "show more" affordance.

use serde::{Deserialize, Serialize};

/// Convenience alias used throughout OpenCat.
pub type Result<T, E = CoreError> = std::result::Result<T, E>;

/// Every failure mode OpenCat can surface.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("configuration error: {0}")]
    Config(String),

    #[error("connection error: {0}")]
    Connection(String),

    #[error("authentication failed: {0}")]
    Auth(String),

    #[error("query error: {0}")]
    Query(String),

    #[error("unsupported feature: {0}")]
    Unsupported(String),

    #[error("object not found: {0}")]
    NotFound(String),

    #[error("invalid input: {0}")]
    Invalid(String),

    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("{0}")]
    Other(String),
}

impl CoreError {
    /// Build an [`CoreError::Other`] from anything printable.
    pub fn other(msg: impl Into<String>) -> Self {
        CoreError::Other(msg.into())
    }

    /// A short, stable machine-readable code (used by the UI for icons/labels).
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::Config(_) => "config",
            CoreError::Connection(_) => "connection",
            CoreError::Auth(_) => "auth",
            CoreError::Query(_) => "query",
            CoreError::Unsupported(_) => "unsupported",
            CoreError::NotFound(_) => "not_found",
            CoreError::Invalid(_) => "invalid",
            CoreError::Io(_) => "io",
            CoreError::Serde(_) => "serde",
            CoreError::Other(_) => "other",
        }
    }
}

/// The IPC representation of a failure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
}

impl From<&CoreError> for ErrorPayload {
    fn from(err: &CoreError) -> Self {
        let detail = match err {
            CoreError::Query(d) | CoreError::Connection(d) | CoreError::Invalid(d) => {
                if d.len() > 400 {
                    Some(d.clone())
                } else {
                    None
                }
            },
            _ => None,
        };
        ErrorPayload {
            code: err.code().to_string(),
            message: err.to_string(),
            detail,
        }
    }
}

impl From<CoreError> for ErrorPayload {
    fn from(err: CoreError) -> Self {
        ErrorPayload::from(&err)
    }
}

impl Serialize for CoreError {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        ErrorPayload::from(self).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for CoreError {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let payload = ErrorPayload::deserialize(deserializer)?;
        Ok(CoreError::Other(payload.message))
    }
}
