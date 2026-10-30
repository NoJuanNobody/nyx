//! PCB file metadata and BOM extraction. Port of `pcb-parser.service.ts` (and its vitest cases).
//!
//! Supports KiCad `.kicad_pcb` (S-expression, scanned with regexes exactly like the TypeScript)
//! and Gerber RS-274X layer files (`.gbr`, `.gbl`, `.gtl`, `.gbs`, `.gts`, `.gbo`, `.gto`).
//!
//! Known limitations carried over from the TypeScript: board dimensions come only from
//! `gr_line` segments on `Edge.Cuts` with non-negative coordinates (`[\d.]+`), so boards drawn
//! with arcs/rects or in negative coordinates report `None`; KiCad 8 `(property "Reference" ..)`
//! footprints (instead of `fp_text`) yield no BOM rows.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::kind::extension;

/// Detected PCB file format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PcbFormat {
    /// KiCad PCB layout.
    Kicad,
    /// Gerber layer.
    Gerber,
    /// Anything else.
    Unknown,
}

/// Board dimensions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoardDimensions {
    /// Width.
    pub width: f64,
    /// Height.
    pub height: f64,
    /// Unit (always `mm`).
    pub unit: String,
}

/// Extracted PCB metadata (TS `PCBMetadata`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PcbMetadata {
    /// Original file name.
    pub file_name: String,
    /// Format.
    pub format: PcbFormat,
    /// Number of layers.
    pub layer_count: usize,
    /// Footprints (KiCad) or aperture definitions (Gerber).
    pub component_count: usize,
    /// Board size when derivable.
    pub board_dimensions: Option<BoardDimensions>,
    /// Layer names.
    pub layers: Vec<String>,
    /// Version/generator (KiCad) or `%TF.` attributes (Gerber).
    pub raw_properties: BTreeMap<String, String>,
}

/// One bill-of-materials row (TS `BOMEntry`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BomEntry {
    /// Reference designators, comma separated when merged.
    pub reference: String,
    /// Component value.
    pub value: String,
    /// Footprint library id.
    pub footprint: String,
    /// Number of identical parts.
    pub quantity: u32,
}

#[allow(clippy::expect_used)]
fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).expect("static regex is valid"))
}

/// Detect the format from the extension.
#[must_use]
pub fn detect_format(file_name: &str) -> PcbFormat {
    match extension(file_name).as_str() {
        "kicad_pcb" => PcbFormat::Kicad,
        "gbr" | "gbl" | "gtl" | "gbs" | "gts" | "gbo" | "gto" => PcbFormat::Gerber,
        _ => PcbFormat::Unknown,
    }
}

/// JavaScript `parseFloat` for strings matching `[\d.]+`: longest valid numeric prefix.
fn js_parse_float(s: &str) -> Option<f64> {
    let mut seen_dot = false;
    let mut end = 0;
    for (i, c) in s.char_indices() {
        match c {
            '0'..='9' => end = i + 1,
            '.' if !seen_dot => {
                seen_dot = true;
                end = i + 1;
            }
            _ => break,
        }
    }
    s[..end].parse().ok()
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn parse_kicad(text: &str, file_name: &str) -> PcbMetadata {
    static LAYER: OnceLock<Regex> = OnceLock::new();
    static FOOT: OnceLock<Regex> = OnceLock::new();
    static EDGE: OnceLock<Regex> = OnceLock::new();
    static VER: OnceLock<Regex> = OnceLock::new();
    static GEN: OnceLock<Regex> = OnceLock::new();

    let layers: Vec<String> = re(&LAYER, r#"\(\d+\s+"?([^")\s]+)"?\s+(\w+)\)"#)
        .captures_iter(text)
        .map(|c| c[1].to_string())
        .collect();
    let component_count = re(&FOOT, r#"\(\s*(?:footprint|module)\s+""#)
        .find_iter(text)
        .count();

    let mut xs = Vec::new();
    let mut ys = Vec::new();
    for c in re(
        &EDGE,
        r"\(\s*gr_line\s+\(start\s+([\d.]+)\s+([\d.]+)\)\s+\(end\s+([\d.]+)\s+([\d.]+)\).*?Edge\.Cuts",
    )
    .captures_iter(text)
    {
        xs.extend(js_parse_float(&c[1]));
        ys.extend(js_parse_float(&c[2]));
        xs.extend(js_parse_float(&c[3]));
        ys.extend(js_parse_float(&c[4]));
    }
    let span = |v: &[f64]| {
        if v.is_empty() {
            0.0
        } else {
            v.iter().copied().fold(f64::MIN, f64::max) - v.iter().copied().fold(f64::MAX, f64::min)
        }
    };
    let (width, height) = (span(&xs), span(&ys));

    let mut raw_properties = BTreeMap::new();
    if let Some(c) = re(&VER, r"\(version\s+(\d+)\)").captures(text) {
        raw_properties.insert("version".to_string(), c[1].to_string());
    }
    if let Some(c) = re(&GEN, r#"\(generator\s+"?([^")]+)"?\)"#).captures(text) {
        raw_properties.insert("generator".to_string(), c[1].to_string());
    }

    PcbMetadata {
        file_name: file_name.to_string(),
        format: PcbFormat::Kicad,
        layer_count: layers.len(),
        component_count,
        board_dimensions: (width > 0.0 || height > 0.0).then(|| BoardDimensions {
            width: round2(width),
            height: round2(height),
            unit: "mm".into(),
        }),
        layers,
        raw_properties,
    }
}

fn parse_gerber(text: &str, file_name: &str) -> PcbMetadata {
    static ATTR: OnceLock<Regex> = OnceLock::new();
    static APERTURE: OnceLock<Regex> = OnceLock::new();

    let mut raw_properties = BTreeMap::new();
    let mut layers = Vec::new();
    for c in re(&ATTR, r"%TF\.(\w+),([^*]+)\*%").captures_iter(text) {
        raw_properties.insert(c[1].to_string(), c[2].to_string());
        if &c[1] == "FileFunction" {
            layers.push(c[2].to_string());
        }
    }
    let component_count = re(&APERTURE, r"%ADD\d+").find_iter(text).count();
    PcbMetadata {
        file_name: file_name.to_string(),
        format: PcbFormat::Gerber,
        layer_count: if layers.is_empty() { 1 } else { layers.len() },
        component_count,
        board_dimensions: None,
        layers,
        raw_properties,
    }
}

/// Parse a PCB file and extract metadata (TS `parsePCBFile`). Invalid UTF-8 is replaced lossily.
#[must_use]
pub fn parse_pcb_file(bytes: &[u8], file_name: &str) -> PcbMetadata {
    let text = String::from_utf8_lossy(bytes);
    match detect_format(file_name) {
        PcbFormat::Kicad => parse_kicad(&text, file_name),
        PcbFormat::Gerber => parse_gerber(&text, file_name),
        PcbFormat::Unknown => PcbMetadata {
            file_name: file_name.to_string(),
            format: PcbFormat::Unknown,
            layer_count: 0,
            component_count: 0,
            board_dimensions: None,
            layers: Vec::new(),
            raw_properties: BTreeMap::new(),
        },
    }
}

/// Extract the bill of materials from a KiCad file (TS `extractBOM`): one row per distinct
/// `value::footprint`, quantities summed, references joined with `", "`, first-seen order.
#[must_use]
pub fn extract_bom(bytes: &[u8], file_name: &str) -> Vec<BomEntry> {
    static START: OnceLock<Regex> = OnceLock::new();
    static REF: OnceLock<Regex> = OnceLock::new();
    static VAL: OnceLock<Regex> = OnceLock::new();

    if detect_format(file_name) != PcbFormat::Kicad {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(bytes);
    // The TS uses a lazy `[\s\S]*?(?=next footprint|$)`; lookahead is unavailable here, so split
    // the text at each footprint start, which is the same partition.
    let starts: Vec<(usize, String)> = re(&START, r#"\(\s*(?:footprint|module)\s+"([^"]+)""#)
        .captures_iter(&text)
        .filter_map(|c| Some((c.get(0)?.start(), c[1].to_string())))
        .collect();

    let mut order: Vec<String> = Vec::new();
    let mut merged: BTreeMap<String, BomEntry> = BTreeMap::new();
    for (i, (from, footprint)) in starts.iter().enumerate() {
        let to = starts.get(i + 1).map_or(text.len(), |s| s.0);
        let block = &text[*from..to];
        let reference = re(&REF, r#"\(\s*fp_text\s+reference\s+"([^"]+)""#)
            .captures(block)
            .map(|c| c[1].to_string())
            .unwrap_or_default();
        if reference.is_empty() {
            continue;
        }
        let value = re(&VAL, r#"\(\s*fp_text\s+value\s+"([^"]+)""#)
            .captures(block)
            .map(|c| c[1].to_string())
            .unwrap_or_default();
        let key = format!("{value}::{footprint}");
        if let Some(e) = merged.get_mut(&key) {
            e.quantity += 1;
            e.reference = format!("{}, {reference}", e.reference);
        } else {
            order.push(key.clone());
            merged.insert(
                key,
                BomEntry {
                    reference,
                    value,
                    footprint: footprint.clone(),
                    quantity: 1,
                },
            );
        }
    }
    order
        .into_iter()
        .filter_map(|k| merged.remove(&k))
        .collect()
}

/// Render metadata and BOM as markdown, used as the text content of a PCB intake.
#[must_use]
pub fn to_markdown(meta: &PcbMetadata, bom: &[BomEntry]) -> String {
    let format = match meta.format {
        PcbFormat::Kicad => "KiCad",
        PcbFormat::Gerber => "Gerber",
        PcbFormat::Unknown => "unknown",
    };
    let mut md = format!("# PCB: {}\n\n- Format: {format}\n", meta.file_name);
    md += &format!(
        "- Layers ({}): {}\n",
        meta.layer_count,
        meta.layers.join(", ")
    );
    md += &format!("- Components: {}\n", meta.component_count);
    if let Some(d) = &meta.board_dimensions {
        md += &format!("- Board size: {} x {} {}\n", d.width, d.height, d.unit);
    }
    for (k, v) in &meta.raw_properties {
        md += &format!("- {k}: {v}\n");
    }
    if !bom.is_empty() {
        md += "\n## Bill of materials\n\n| Reference | Value | Footprint | Qty |\n| --- | --- | --- | --- |\n";
        for e in bom {
            md += &format!(
                "| {} | {} | {} | {} |\n",
                e.reference, e.value, e.footprint, e.quantity
            );
        }
    }
    md
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const KICAD: &str = r#"
(kicad_pcb (version 20221018) (generator "pcbnew")

  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (32 "B.Adhes" user)
    (33 "F.Adhes" user)
    (36 "B.SilkS" user)
    (37 "F.SilkS" user)
    (44 "Edge.Cuts" user)
  )

  (gr_line (start 10 10) (end 60 10) (layer "Edge.Cuts") (width 0.05))
  (gr_line (start 60 10) (end 60 40) (layer "Edge.Cuts") (width 0.05))
  (gr_line (start 60 40) (end 10 40) (layer "Edge.Cuts") (width 0.05))
  (gr_line (start 10 40) (end 10 10) (layer "Edge.Cuts") (width 0.05))

  (footprint "Resistor_SMD:R_0402_1005Metric"
    (fp_text reference "R1" (at 0 0) (layer "F.SilkS"))
    (fp_text value "10k" (at 0 1) (layer "F.Fab"))
  )
  (footprint "Resistor_SMD:R_0402_1005Metric"
    (fp_text reference "R2" (at 0 0) (layer "F.SilkS"))
    (fp_text value "10k" (at 0 1) (layer "F.Fab"))
  )
  (footprint "Capacitor_SMD:C_0402_1005Metric"
    (fp_text reference "C1" (at 0 0) (layer "F.SilkS"))
    (fp_text value "100nF" (at 0 1) (layer "F.Fab"))
  )
  (footprint "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm"
    (fp_text reference "U1" (at 0 0) (layer "F.SilkS"))
    (fp_text value "ATtiny85" (at 0 1) (layer "F.Fab"))
  )
)
"#;

    const GERBER: &str = "
G04 Layer: Top Copper*
%TF.GenerationSoftware,KiCad,Pcbnew,7.0.0*%
%TF.FileFunction,Copper,L1,Top*%
%TF.FilePolarity,Positive*%
%FSLAX46Y46*%
%MOMM*%
%ADD10C,0.200000*%
%ADD11R,1.700000X1.700000*%
%ADD12O,1.700000X1.700000*%
D10*
X100000Y200000D03*
X300000Y200000D03*
M02*
";

    fn kicad() -> PcbMetadata {
        parse_pcb_file(KICAD.as_bytes(), "board.kicad_pcb")
    }

    #[test]
    fn kicad_format_layers_components() {
        let m = kicad();
        assert_eq!(m.format, PcbFormat::Kicad);
        assert_eq!(m.file_name, "board.kicad_pcb");
        assert_eq!(m.layer_count, 7);
        for l in ["F.Cu", "B.Cu", "Edge.Cuts"] {
            assert!(m.layers.iter().any(|x| x == l));
        }
        assert_eq!(m.component_count, 4);
    }

    #[test]
    fn kicad_dimensions_and_properties() {
        let m = kicad();
        let d = m.board_dimensions.unwrap();
        assert_eq!((d.width, d.height, d.unit.as_str()), (50.0, 30.0, "mm"));
        assert_eq!(m.raw_properties["version"], "20221018");
        assert_eq!(m.raw_properties["generator"], "pcbnew");
    }

    #[test]
    fn kicad_without_edge_cuts() {
        let src = "(kicad_pcb (version 20221018) (generator \"pcbnew\")\n (layers\n (0 \"F.Cu\" signal)\n (31 \"B.Cu\" signal)\n )\n)";
        let m = parse_pcb_file(src.as_bytes(), "minimal.kicad_pcb");
        assert!(m.board_dimensions.is_none());
        assert_eq!((m.layer_count, m.component_count), (2, 0));
    }

    #[test]
    fn gerber_extensions_and_attributes() {
        for ext in ["gbr", "gbl", "gtl", "gbs", "gts", "gbo", "gto"] {
            assert_eq!(
                parse_pcb_file(GERBER.as_bytes(), &format!("l.{ext}")).format,
                PcbFormat::Gerber
            );
        }
        let m = parse_pcb_file(GERBER.as_bytes(), "top_copper.gbr");
        assert_eq!(m.raw_properties["FileFunction"], "Copper,L1,Top");
        assert_eq!(m.raw_properties["FilePolarity"], "Positive");
        assert!(m.layers.contains(&"Copper,L1,Top".to_string()));
        assert_eq!(m.component_count, 3);
        assert!(m.board_dimensions.is_none());
        assert_eq!(m.layer_count, 1);
    }

    #[test]
    fn unknown_and_empty() {
        let m = parse_pcb_file(b"some random content", "design.eagle");
        assert_eq!(
            (m.format, m.layer_count, m.component_count),
            (PcbFormat::Unknown, 0, 0)
        );
        assert!(m.layers.is_empty());
        let e = parse_pcb_file(b"", "empty.kicad_pcb");
        assert_eq!(
            (e.format, e.layer_count, e.component_count),
            (PcbFormat::Kicad, 0, 0)
        );
        assert!(e.board_dimensions.is_none());
    }

    #[test]
    fn bom_dedupes_by_value_and_footprint() {
        let bom = extract_bom(KICAD.as_bytes(), "board.kicad_pcb");
        assert_eq!(bom.len(), 3);
        let r = bom.iter().find(|e| e.value == "10k").unwrap();
        assert_eq!(r.quantity, 2);
        assert_eq!(r.footprint, "Resistor_SMD:R_0402_1005Metric");
        assert_eq!(r.reference, "R1, R2");
        assert_eq!(bom.iter().find(|e| e.value == "100nF").unwrap().quantity, 1);
        assert_eq!(
            bom.iter().find(|e| e.value == "ATtiny85").unwrap().quantity,
            1
        );
        assert_eq!(bom[0].value, "10k", "first-seen order");
    }

    #[test]
    fn bom_empty_cases() {
        assert!(extract_bom(GERBER.as_bytes(), "layer.gbr").is_empty());
        assert!(extract_bom(b"random content", "file.txt").is_empty());
        assert!(extract_bom(b"(kicad_pcb (layers (0 \"F.Cu\" signal)))", "e.kicad_pcb").is_empty());
    }

    #[test]
    fn markdown_summary_mentions_bom() {
        let m = kicad();
        let md = to_markdown(&m, &extract_bom(KICAD.as_bytes(), "board.kicad_pcb"));
        assert!(md.contains("# PCB: board.kicad_pcb"));
        assert!(md.contains("Format: KiCad"));
        assert!(md.contains("| R1, R2 | 10k |"));
        assert!(md.contains("50 x 30 mm"));
    }

    #[test]
    fn float_prefix_parsing() {
        assert_eq!(js_parse_float("1.2.3"), Some(1.2));
        assert_eq!(js_parse_float(".5"), Some(0.5));
        assert_eq!(js_parse_float("."), None);
        assert_eq!(js_parse_float("12"), Some(12.0));
    }
}
