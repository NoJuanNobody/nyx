//! Jupyter notebook export (TS `export-jupyter.service.ts`).
//!
//! Fenced code blocks become code cells, everything else is grouped into markdown cells. Output is
//! `nbformat` 4.5 JSON. Differences from the TS output, both deliberate:
//!
//! - every cell carries an `id` (`cell-0`, `cell-1`, ...), which `nbformat` 4.5 requires (the TS
//!   emitted `nbformat_minor: 5` without ids, which strict validators reject). Ids are
//!   deterministic so output is reproducible.
//! - JSON object keys are emitted alphabetically (`serde_json` default), TS used insertion order.
//!   Both are equivalent JSON.

use serde_json::{json, Value};

use crate::error::Result;

/// Split text into notebook "source" lines: every element ends in `\n` except the last.
/// Empty text yields no lines (TS `toSourceLines`).
#[must_use]
pub fn to_source_lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let last = lines.len() - 1;
    lines
        .iter()
        .enumerate()
        .map(|(i, l)| {
            if i < last {
                format!("{l}\n")
            } else {
                (*l).to_string()
            }
        })
        .collect()
}

fn is_fence_open(line: &str) -> bool {
    // TS: /^```(\w*)/ matches any line starting with three backticks.
    line.starts_with("```")
}

/// Convert Markdown to a notebook value.
#[must_use]
pub fn markdown_to_notebook(markdown: &str, title: &str) -> Value {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut cells: Vec<Value> = Vec::new();
    let mut buffer: Vec<&str> = Vec::new();
    let mut i = 0;

    let flush = |buffer: &mut Vec<&str>, cells: &mut Vec<Value>| {
        if buffer.is_empty() {
            return;
        }
        let id = format!("cell-{}", cells.len());
        cells.push(json!({
            "cell_type": "markdown",
            "id": id,
            "metadata": {},
            "source": to_source_lines(&buffer.join("\n")),
        }));
        buffer.clear();
    };

    while i < lines.len() {
        let line = lines[i];
        if is_fence_open(line) {
            flush(&mut buffer, &mut cells);
            let mut code: Vec<&str> = Vec::new();
            i += 1;
            while i < lines.len() && !lines[i].starts_with("```") {
                code.push(lines[i]);
                i += 1;
            }
            i += 1; // closing fence
            let id = format!("cell-{}", cells.len());
            cells.push(json!({
                "cell_type": "code",
                "execution_count": null,
                "id": id,
                "metadata": {},
                "outputs": [],
                "source": to_source_lines(&code.join("\n")),
            }));
            continue;
        }
        buffer.push(line);
        i += 1;
    }
    flush(&mut buffer, &mut cells);

    json!({
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3",
            },
            "language_info": { "name": "python", "version": "3.11.0" },
            "title": title,
        },
        "cells": cells,
    })
}

/// Pretty-printed (2 space) notebook JSON bytes, as served by the TS route.
pub fn to_notebook_bytes(markdown: &str, title: &str) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec_pretty(&markdown_to_notebook(
        markdown, title,
    ))?)
}

/// Structural validation used by tests and callers that load notebooks back: checks the `nbformat`
/// 4 invariants this exporter promises (version, kernelspec, cell shapes, string-array sources).
pub fn validate_notebook(nb: &Value) -> std::result::Result<(), String> {
    if nb["nbformat"] != 4 {
        return Err("nbformat must be 4".into());
    }
    if !nb["nbformat_minor"].is_u64() {
        return Err("nbformat_minor missing".into());
    }
    if !nb["metadata"]["kernelspec"]["name"].is_string() {
        return Err("metadata.kernelspec.name missing".into());
    }
    let cells = nb["cells"].as_array().ok_or("cells must be an array")?;
    for (n, c) in cells.iter().enumerate() {
        let kind = c["cell_type"]
            .as_str()
            .ok_or(format!("cell {n}: no cell_type"))?;
        if !c["metadata"].is_object() {
            return Err(format!("cell {n}: metadata must be an object"));
        }
        if !c["id"].is_string() {
            return Err(format!("cell {n}: id missing"));
        }
        let src = c["source"]
            .as_array()
            .ok_or(format!("cell {n}: source must be an array"))?;
        if !src.iter().all(Value::is_string) {
            return Err(format!("cell {n}: source must be strings"));
        }
        match kind {
            "markdown" => {}
            "code" => {
                if !c["outputs"].is_array()
                    || !c
                        .get("execution_count")
                        .is_some_and(|v| v.is_null() || v.is_u64())
                {
                    return Err(format!(
                        "cell {n}: code cell needs outputs and execution_count"
                    ));
                }
            }
            other => return Err(format!("cell {n}: unexpected cell_type {other}")),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cells(nb: &Value) -> &Vec<Value> {
        nb["cells"].as_array().unwrap()
    }

    fn src(c: &Value) -> String {
        c["source"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect()
    }

    #[test]
    fn notebook_structure() {
        let nb = markdown_to_notebook("# Hello", "Untitled");
        assert_eq!(nb["nbformat"], 4);
        assert_eq!(nb["nbformat_minor"], 5);
        assert!(nb["metadata"]["kernelspec"].is_object());
        validate_notebook(&nb).unwrap();
    }

    #[test]
    fn markdown_only_document() {
        let nb = markdown_to_notebook(
            "# Heading\n\nParagraph one.\n\n## Sub\n\nParagraph two.",
            "T",
        );
        assert_eq!(cells(&nb).len(), 1);
        assert!(cells(&nb).iter().all(|c| c["cell_type"] == "markdown"));
    }

    #[test]
    fn code_cells() {
        let nb = markdown_to_notebook("```python\nprint(\"hello\")\n```", "T");
        let c = &cells(&nb)[0];
        assert_eq!(cells(&nb).len(), 1);
        assert_eq!(c["cell_type"], "code");
        assert_eq!(c["outputs"], json!([]));
        assert!(c["execution_count"].is_null());
        assert_eq!(src(c), "print(\"hello\")");
        assert!(!src(c).contains("```"));
    }

    #[test]
    fn two_adjacent_code_blocks() {
        let nb = markdown_to_notebook("```python\nx = 1\n```\n```python\ny = 2\n```", "T");
        assert_eq!(
            cells(&nb)
                .iter()
                .filter(|c| c["cell_type"] == "code")
                .count(),
            2
        );
    }

    #[test]
    fn mixed_order() {
        let nb = markdown_to_notebook(
            "Some intro text\n\n```python\nx = 1\n```\n\nMore text after code",
            "T",
        );
        let kinds: Vec<_> = cells(&nb)
            .iter()
            .map(|c| c["cell_type"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["markdown", "code", "markdown"]);
    }

    #[test]
    fn empty_document_is_one_empty_markdown_cell() {
        // TS: '' splits to [''] which becomes one markdown cell with an empty source.
        let nb = markdown_to_notebook("", "T");
        assert_eq!(nb["nbformat"], 4);
        assert_eq!(cells(&nb).len(), 1);
        assert_eq!(cells(&nb)[0]["source"], json!([]));
        validate_notebook(&nb).unwrap();
    }

    #[test]
    fn title_in_metadata() {
        let nb = markdown_to_notebook("# Hello", "My Notebook");
        assert_eq!(nb["metadata"]["title"], "My Notebook");
    }

    #[test]
    fn source_lines_keep_newlines() {
        assert_eq!(to_source_lines("a\nb\nc"), ["a\n", "b\n", "c"]);
        assert_eq!(to_source_lines("a\n"), ["a\n", ""]);
        assert_eq!(to_source_lines(""), Vec::<String>::new());
    }

    #[test]
    fn golden_json() {
        let bytes = to_notebook_bytes("Intro\n\n```python\nx = 1\n```", "Demo").unwrap();
        let expected = r#"{
  "cells": [
    {
      "cell_type": "markdown",
      "id": "cell-0",
      "metadata": {},
      "source": [
        "Intro\n",
        ""
      ]
    },
    {
      "cell_type": "code",
      "execution_count": null,
      "id": "cell-1",
      "metadata": {},
      "outputs": [],
      "source": [
        "x = 1"
      ]
    }
  ],
  "metadata": {
    "kernelspec": {
      "display_name": "Python 3",
      "language": "python",
      "name": "python3"
    },
    "language_info": {
      "name": "python",
      "version": "3.11.0"
    },
    "title": "Demo"
  },
  "nbformat": 4,
  "nbformat_minor": 5
}"#;
        assert_eq!(String::from_utf8(bytes).unwrap(), expected);
    }

    #[test]
    fn validator_rejects_bad_notebooks() {
        assert!(validate_notebook(&json!({"nbformat": 3})).is_err());
        let mut nb = markdown_to_notebook("```\nx\n```", "T");
        nb["cells"][0]["outputs"] = json!(null);
        assert!(validate_notebook(&nb).is_err());
    }
}
