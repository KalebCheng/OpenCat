//! Typed cell values.
//!
//! OpenCat never coerces database values into `String` at the driver boundary —
//! that would lose the type information the grid needs for right-aligned numbers,
//! hex viewers, date pickers and, most importantly, for writing edits back with
//! the correct SQL literal. Instead every cell travels as a [`Value`].
//!
//! On the wire the enum is tagged (`{"t":"int","v":42}`) so the TypeScript side
//! can narrow it with a simple discriminated union.

use base64::Engine as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// The family of a value, used by the UI to pick renderers and editors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueKind {
    Null,
    Bool,
    Int,
    Uint,
    Float,
    Decimal,
    Text,
    Bytes,
    Date,
    Time,
    DateTime,
    Json,
}

/// A single database cell.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum Value {
    /// Absence of a value — the default for a cell that was never set.
    #[default]
    Null,
    Bool(bool),
    Int(i64),
    Uint(u64),
    Float(f64),
    /// Exact numeric kept as text to avoid binary floating point drift.
    Decimal(String),
    Text(String),
    Bytes(Vec<u8>),
    /// `YYYY-MM-DD`
    Date(String),
    /// `HH:MM:SS[.ffffff]`
    Time(String),
    /// `YYYY-MM-DD HH:MM:SS[.ffffff]` (optionally with offset)
    DateTime(String),
    /// Raw JSON text.
    Json(String),
}

impl Value {
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    pub fn kind(&self) -> ValueKind {
        match self {
            Value::Null => ValueKind::Null,
            Value::Bool(_) => ValueKind::Bool,
            Value::Int(_) => ValueKind::Int,
            Value::Uint(_) => ValueKind::Uint,
            Value::Float(_) => ValueKind::Float,
            Value::Decimal(_) => ValueKind::Decimal,
            Value::Text(_) => ValueKind::Text,
            Value::Bytes(_) => ValueKind::Bytes,
            Value::Date(_) => ValueKind::Date,
            Value::Time(_) => ValueKind::Time,
            Value::DateTime(_) => ValueKind::DateTime,
            Value::Json(_) => ValueKind::Json,
        }
    }

    /// Canonical text used by the data grid and by CSV/JSON export.
    pub fn display_text(&self) -> Option<String> {
        match self {
            Value::Null => None,
            Value::Bool(b) => Some(if *b { "1".into() } else { "0".into() }),
            Value::Int(i) => Some(i.to_string()),
            Value::Uint(u) => Some(u.to_string()),
            Value::Float(f) => Some(format_float(*f)),
            Value::Decimal(d) | Value::Text(d) | Value::Json(d) => Some(d.clone()),
            Value::Date(d) | Value::Time(d) | Value::DateTime(d) => Some(d.clone()),
            Value::Bytes(b) => Some(format!("<{} bytes>", b.len())),
        }
    }

    /// A JSON-safe projection used by the desktop frontend.
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Value::Null => serde_json::Value::Null,
            Value::Bool(b) => serde_json::json!({ "t": "bool", "v": b }),
            Value::Int(i) => serde_json::json!({ "t": "int", "v": i }),
            Value::Uint(u) => serde_json::json!({ "t": "uint", "v": u }),
            Value::Float(f) => serde_json::json!({ "t": "float", "v": f }),
            Value::Decimal(d) => serde_json::json!({ "t": "decimal", "v": d }),
            Value::Text(t) => serde_json::json!({ "t": "text", "v": t }),
            Value::Json(j) => serde_json::json!({ "t": "json", "v": j }),
            Value::Bytes(b) => serde_json::json!({
                "t": "bytes",
                "v": base64::engine::general_purpose::STANDARD.encode(b),
                "len": b.len(),
            }),
            Value::Date(d) => serde_json::json!({ "t": "date", "v": d }),
            Value::Time(d) => serde_json::json!({ "t": "time", "v": d }),
            Value::DateTime(d) => serde_json::json!({ "t": "datetime", "v": d }),
        }
    }
}

/// Render a float without a trailing `.0` for integral values, and without the
/// scientific notation that would break `INSERT` round-trips for big numbers.
pub fn format_float(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if f.fract() == 0.0 && f.abs() < 1e15 {
        return format!("{}", f as i64);
    }
    let s = format!("{f}");
    if s.contains('e') || s.contains('E') {
        format!("{f:.15}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    } else {
        s
    }
}

// --- serde: tagged representation -------------------------------------------

impl Serialize for Value {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error as _;
        let raw = serde_json::Value::deserialize(deserializer)?;
        from_json(&raw).map_err(D::Error::custom)
    }
}

/// Rebuild a [`Value`] from its IPC projection.
pub fn from_json(raw: &serde_json::Value) -> Result<Value, String> {
    if raw.is_null() {
        return Ok(Value::Null);
    }
    let obj = raw
        .as_object()
        .ok_or_else(|| "value must be an object".to_string())?;
    let tag = obj.get("t").and_then(|v| v.as_str()).unwrap_or("text");
    let payload = obj.get("v").cloned().unwrap_or(serde_json::Value::Null);
    Ok(match tag {
        "null" => Value::Null,
        "bool" => Value::Bool(payload.as_bool().unwrap_or(false)),
        "int" => Value::Int(
            payload
                .as_i64()
                .or_else(|| payload.as_str().and_then(|s| s.parse().ok()))
                .ok_or_else(|| "invalid int".to_string())?,
        ),
        "uint" => Value::Uint(
            payload
                .as_u64()
                .or_else(|| payload.as_str().and_then(|s| s.parse().ok()))
                .ok_or_else(|| "invalid uint".to_string())?,
        ),
        "float" => Value::Float(
            payload
                .as_f64()
                .or_else(|| payload.as_str().and_then(|s| s.parse().ok()))
                .ok_or_else(|| "invalid float".to_string())?,
        ),
        "decimal" => Value::Decimal(payload.as_str().unwrap_or_default().to_string()),
        "text" => Value::Text(payload.as_str().unwrap_or_default().to_string()),
        "json" => Value::Json(payload.as_str().unwrap_or_default().to_string()),
        "bytes" => Value::Bytes(
            base64::engine::general_purpose::STANDARD
                .decode(payload.as_str().unwrap_or_default())
                .map_err(|e| e.to_string())?,
        ),
        "date" => Value::Date(payload.as_str().unwrap_or_default().to_string()),
        "time" => Value::Time(payload.as_str().unwrap_or_default().to_string()),
        "datetime" => Value::DateTime(payload.as_str().unwrap_or_default().to_string()),
        other => return Err(format!("unknown value tag `{other}`")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn float_formatting_is_sql_friendly() {
        assert_eq!(format_float(12.0), "12");
        assert_eq!(format_float(12.5), "12.5");
        assert_eq!(format_float(-0.25), "-0.25");
    }

    #[test]
    fn round_trips_through_json() {
        for v in [
            Value::Null,
            Value::Bool(true),
            Value::Int(-5),
            Value::Uint(5),
            Value::Float(1.5),
            Value::Decimal("10.001".into()),
            Value::Text("héllo".into()),
            Value::Bytes(vec![0, 1, 2, 255]),
            Value::Date("2024-01-01".into()),
            Value::DateTime("2024-01-01 10:00:00".into()),
            Value::Json("{\"a\":1}".into()),
        ] {
            let js = serde_json::to_value(&v).unwrap();
            let back: Value = serde_json::from_value(js).unwrap();
            assert_eq!(v, back);
        }
    }
}
