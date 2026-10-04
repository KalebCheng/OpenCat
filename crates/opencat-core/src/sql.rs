//! Dialect-aware SQL helpers shared by every driver, the editor and the
//! import/export pipeline.

use once_cell::sync::Lazy;
use regex::Regex;

use crate::model::{DbKind, StatementKind};

/// Quote an identifier for `kind`, escaping the quote character by doubling it.
pub fn quote_ident(name: &str, kind: DbKind) -> String {
    let q = kind.quote_char();
    format!("{q}{}{q}", name.replace(q, &format!("{q}{q}")))
}

/// Quote a dotted path, e.g. `schema.table`.
pub fn quote_path(parts: &[&str], kind: DbKind) -> String {
    parts
        .iter()
        .map(|p| quote_ident(p, kind))
        .collect::<Vec<_>>()
        .join(".")
}

/// Escape a string so it can be embedded in a single-quoted SQL literal.
///
/// Prefer bound parameters; this exists for DDL, `EXPLAIN` and engines where
/// placeholders are unavailable in the position being edited.
pub fn escape_literal(value: &str, kind: DbKind) -> String {
    let escaped = value.replace('\'', "''");
    match kind {
        DbKind::Mysql => format!("'{}'", escaped.replace('\\', "\\\\")),
        _ => format!("'{escaped}'"),
    }
}

static LEADING_KEYWORD: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?is)^\s*(?:/\*.*?\*/\s*|--[^\n]*\n\s*)*([a-z]+)").unwrap());

/// Classify a statement by its leading keyword.
pub fn classify_statement(sql: &str) -> StatementKind {
    let keyword = LEADING_KEYWORD
        .captures(sql)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_ascii_lowercase())
        .unwrap_or_default();

    match keyword.as_str() {
        "select" | "show" | "describe" | "desc" | "explain" | "with" | "values" | "table"
        | "pragma" => StatementKind::Select,
        "insert" | "replace" | "upsert" | "copy" => StatementKind::Insert,
        "update" => StatementKind::Update,
        "delete" | "truncate" => StatementKind::Delete,
        "create" | "alter" | "drop" | "rename" | "comment" | "grant" | "revoke" | "vacuum"
        | "analyze" | "reindex" | "attach" | "detach" => StatementKind::Ddl,
        _ => StatementKind::Other,
    }
}

/// True when the statement looks safe to run on a read-only connection.
pub fn is_read_only(sql: &str) -> bool {
    // A `WITH ... DELETE` CTE is still a write, so scan for mutating keywords
    // rather than trusting the leading one alone.
    let kind = classify_statement(sql);
    if !matches!(kind, StatementKind::Select) {
        return false;
    }
    let lowered = strip_sql_noise(sql).to_ascii_lowercase();
    !MUTATING_KEYWORDS
        .iter()
        .any(|kw| contains_keyword(&lowered, kw))
}

const MUTATING_KEYWORDS: [&str; 12] = [
    "insert", "update", "delete", "drop", "alter", "create", "truncate", "grant", "revoke",
    "replace", "merge", "vacuum",
];

/// Case-insensitive whole-word search.
fn contains_keyword(haystack: &str, needle: &str) -> bool {
    let mut start = 0usize;
    while let Some(pos) = haystack[start..].find(needle) {
        let abs = start + pos;
        let before_ok = abs == 0
            || !haystack[..abs]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_alphanumeric() || c == '_');
        let after = abs + needle.len();
        let after_ok = after >= haystack.len()
            || !haystack[after..]
                .chars()
                .next()
                .is_some_and(|c| c.is_alphanumeric() || c == '_');
        if before_ok && after_ok {
            return true;
        }
        start = abs + needle.len();
    }
    false
}

/// Remove comments and string literals so keyword scanning cannot be fooled by
/// text inside them.
pub fn strip_sql_noise(sql: &str) -> String {
    let bytes: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        // line comments
        if c == '-' && i + 1 < bytes.len() && bytes[i + 1] == '-' {
            while i < bytes.len() && bytes[i] != '\n' {
                i += 1;
            }
            out.push(' ');
            continue;
        }
        if c == '#' {
            while i < bytes.len() && bytes[i] != '\n' {
                i += 1;
            }
            out.push(' ');
            continue;
        }
        // block comments
        if c == '/' && i + 1 < bytes.len() && bytes[i + 1] == '*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == '*' && bytes[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            out.push(' ');
            continue;
        }
        // literals
        if c == '\'' || c == '"' || c == '`' {
            let quote = c;
            out.push(' ');
            i += 1;
            while i < bytes.len() {
                if bytes[i] == '\\' && quote == '\'' {
                    i += 2;
                    continue;
                }
                if bytes[i] == quote {
                    // doubled quote is an escaped quote
                    if i + 1 < bytes.len() && bytes[i + 1] == quote {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Split a script into individual statements.
///
/// Understands `'...'`, `"..."`, `` `...` ``, `--`/`#` line comments, `/* */`
/// block comments and PostgreSQL `$tag$ ... $tag$` dollar quoting.
pub fn split_statements(sql: &str) -> Vec<String> {
    let chars: Vec<char> = sql.chars().collect();
    let mut statements: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut i = 0usize;

    while i < chars.len() {
        let c = chars[i];

        // -- line comment
        if c == '-' && i + 1 < chars.len() && chars[i + 1] == '-' {
            while i < chars.len() && chars[i] != '\n' {
                current.push(chars[i]);
                i += 1;
            }
            continue;
        }
        // # line comment (MySQL)
        if c == '#' {
            while i < chars.len() && chars[i] != '\n' {
                current.push(chars[i]);
                i += 1;
            }
            continue;
        }
        // /* block comment */
        if c == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
            while i < chars.len()
                && !(chars[i] == '*' && i + 1 < chars.len() && chars[i + 1] == '/')
            {
                current.push(chars[i]);
                i += 1;
            }
            if i < chars.len() {
                current.push('*');
                current.push('/');
                i += 2;
            }
            continue;
        }
        // quoted literal / identifier
        if c == '\'' || c == '"' || c == '`' {
            let quote = c;
            current.push(c);
            i += 1;
            while i < chars.len() {
                let ch = chars[i];
                current.push(ch);
                if ch == '\\' && quote == '\'' && i + 1 < chars.len() {
                    current.push(chars[i + 1]);
                    i += 2;
                    continue;
                }
                if ch == quote {
                    if i + 1 < chars.len() && chars[i + 1] == quote {
                        current.push(chars[i + 1]);
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        // PostgreSQL dollar quoting
        if c == '$' {
            if let Some(tag) = dollar_tag(&chars, i) {
                let tag_chars: Vec<char> = tag.chars().collect();
                for _ in 0..tag_chars.len() {
                    current.push(chars[i]);
                    i += 1;
                }
                // copy until the closing tag
                while i < chars.len() {
                    if chars[i] == '$' && starts_with(&chars, i, &tag_chars) {
                        for _ in 0..tag_chars.len() {
                            current.push(chars[i]);
                            i += 1;
                        }
                        break;
                    }
                    current.push(chars[i]);
                    i += 1;
                }
                continue;
            }
        }
        // statement separator
        if c == ';' {
            let trimmed = current.trim();
            if !trimmed.is_empty() {
                statements.push(trimmed.to_string());
            }
            current.clear();
            i += 1;
            continue;
        }

        current.push(c);
        i += 1;
    }

    let trimmed = current.trim();
    if !trimmed.is_empty() {
        statements.push(trimmed.to_string());
    }
    statements
}

fn starts_with(chars: &[char], at: usize, needle: &[char]) -> bool {
    if at + needle.len() > chars.len() {
        return false;
    }
    chars[at..at + needle.len()] == *needle
}

/// If `chars[i]` starts a `$tag$` opener, return the full tag including dollars.
fn dollar_tag(chars: &[char], i: usize) -> Option<String> {
    debugger_assert(chars[i] == '$');
    let mut j = i + 1;
    while j < chars.len() {
        let c = chars[j];
        if c == '$' {
            return Some(chars[i..=j].iter().collect());
        }
        if !(c.is_alphanumeric() || c == '_') {
            return None;
        }
        j += 1;
    }
    None
}

#[inline]
fn debugger_assert(_cond: bool) {
    debug_assert!(_cond);
}

/// Number of statements in a script.
pub fn count_statements(sql: &str) -> usize {
    split_statements(sql).len()
}

/// Extract the table name from a simple `SELECT ... FROM <table>` statement.
/// Used to decide whether a result set is editable.
pub fn detect_result_table(sql: &str, kind: DbKind) -> Option<(Option<String>, String)> {
    static FROM_RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r#"(?is)\bfrom\s+((?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*))?)"#)
            .unwrap()
    });

    if !matches!(classify_statement(sql), StatementKind::Select) {
        return None;
    }
    // Bail out on anything that would make the mapping ambiguous.
    let noise = strip_sql_noise(sql).to_ascii_lowercase();
    for kw in [" join ", " group by ", " union ", " distinct ", " having "] {
        if noise.contains(kw) {
            return None;
        }
    }

    let caps = FROM_RE.captures(sql)?;
    let raw = caps.get(1)?.as_str();
    let parts: Vec<String> = raw
        .split('.')
        .map(|p| {
            let p = p.trim();
            if p.len() >= 2
                && ((p.starts_with('"') && p.ends_with('"'))
                    || (p.starts_with('`') && p.ends_with('`')))
            {
                p[1..p.len() - 1].replace("\"\"", "\"").replace("``", "`")
            } else {
                p.to_string()
            }
        })
        .collect();

    match (kind, parts.len()) {
        (_, 1) => Some((None, parts[0].clone())),
        (DbKind::Mysql, 2) => Some((Some(parts[0].clone()), parts[1].clone())),
        (_, 2) => Some((Some(parts[0].clone()), parts[1].clone())),
        (_, 3) => Some((Some(format!("{}.{}", parts[0], parts[1])), parts[2].clone())),
        _ => None,
    }
}

/// Truncate a statement for display in the history list.
pub fn summarise(sql: &str, max: usize) -> String {
    let one_line: String = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        one_line
    } else {
        let mut s: String = one_line.chars().take(max.saturating_sub(1)).collect();
        s.push('…');
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_semicolons_outside_literals() {
        let sql = "SELECT ';' AS a; SELECT 2; -- trailing;\nSELECT 3";
        let parts = split_statements(sql);
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], "SELECT ';' AS a");
        assert_eq!(parts[1], "SELECT 2");
        // The comment sits after the separator, so it belongs to the next
        // statement and is preserved for fidelity.
        assert!(parts[2].ends_with("SELECT 3"), "{:?}", parts[2]);
    }

    #[test]
    fn handles_block_comments_and_dollar_quotes() {
        let sql = "/* a; b */ SELECT 1; $$ drop; $$ ; SELECT 2";
        let parts = split_statements(sql);
        assert_eq!(parts.len(), 3, "{parts:?}");
    }

    #[test]
    fn classifies_statements() {
        assert_eq!(classify_statement("  select 1"), StatementKind::Select);
        assert_eq!(
            classify_statement("-- x\nINSERT INTO t VALUES (1)"),
            StatementKind::Insert
        );
        assert_eq!(
            classify_statement("CREATE TABLE t (a int)"),
            StatementKind::Ddl
        );
    }

    #[test]
    fn detects_read_only() {
        assert!(is_read_only("SELECT * FROM t"));
        assert!(!is_read_only("WITH x AS (SELECT 1) DELETE FROM t"));
        assert!(!is_read_only("SELECT 1; DROP TABLE t"));
    }

    #[test]
    fn quotes_identifiers() {
        assert_eq!(quote_ident("we\"ird", DbKind::Postgres), "\"we\"\"ird\"");
        assert_eq!(quote_ident("tbl", DbKind::Mysql), "`tbl`");
    }

    #[test]
    fn detects_result_table() {
        assert_eq!(
            detect_result_table("SELECT * FROM public.users", DbKind::Postgres),
            Some((Some("public".into()), "users".into()))
        );
        assert_eq!(
            detect_result_table("select * from `mydb`.`t`", DbKind::Mysql),
            Some((Some("mydb".into()), "t".into()))
        );
        assert_eq!(
            detect_result_table("SELECT * FROM a JOIN b ON 1=1", DbKind::Postgres),
            None
        );
    }
}
