/**
 * PCB parser service — extracts metadata from PCB design files.
 *
 * Supported formats:
 *  - .kicad_pcb  → KiCad PCB layout files (metadata + BOM extraction)
 *  - .gbr        → Gerber RS-274X files (basic metadata extraction)
 *
 * For MVP, this focuses on metadata extraction. Actual board rendering
 * can be added as a follow-up.
 */

export interface PCBMetadata {
  fileName: string;
  format: 'kicad' | 'gerber' | 'unknown';
  layerCount: number;
  componentCount: number;
  boardDimensions: {
    width: number;
    height: number;
    unit: string;
  } | null;
  layers: string[];
  rawProperties: Record<string, string>;
}

export interface BOMEntry {
  reference: string;
  value: string;
  footprint: string;
  quantity: number;
}

/**
 * Detect the PCB file format from its extension.
 */
function detectFormat(fileName: string): PCBMetadata['format'] {
  const ext = fileName.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'kicad_pcb':
      return 'kicad';
    case 'gbr':
    case 'gbl':
    case 'gtl':
    case 'gbs':
    case 'gts':
    case 'gbo':
    case 'gto':
      return 'gerber';
    default:
      return 'unknown';
  }
}

/**
 * Parse a KiCad PCB file and extract metadata.
 *
 * KiCad PCB files use an S-expression format. We extract:
 *  - layers from (layers ...) blocks
 *  - footprints/modules for component count
 *  - board dimensions from the general section or gr_line edges
 */
function parseKicadPCB(text: string, fileName: string): PCBMetadata {
  const layers: string[] = [];
  const rawProperties: Record<string, string> = {};

  // Extract layers: lines like `(N "layer_name" type)` inside (layers ...)
  const layerRegex = /\(\d+\s+"?([^")\s]+)"?\s+(\w+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = layerRegex.exec(text)) !== null) {
    layers.push(match[1]);
  }

  // Count footprints (components) — (footprint "..." or (module "..."
  const footprintMatches = text.match(/\(\s*(?:footprint|module)\s+"/g);
  const componentCount = footprintMatches ? footprintMatches.length : 0;

  // Extract board dimensions from edge cuts (gr_line on Edge.Cuts layer)
  let width = 0;
  let height = 0;
  const edgeCutLines: { x: number; y: number }[] = [];

  const grLineRegex =
    /\(\s*gr_line\s+\(start\s+([\d.]+)\s+([\d.]+)\)\s+\(end\s+([\d.]+)\s+([\d.]+)\).*?Edge\.Cuts/g;
  while ((match = grLineRegex.exec(text)) !== null) {
    edgeCutLines.push(
      { x: parseFloat(match[1]), y: parseFloat(match[2]) },
      { x: parseFloat(match[3]), y: parseFloat(match[4]) },
    );
  }

  if (edgeCutLines.length > 0) {
    const xs = edgeCutLines.map((p) => p.x);
    const ys = edgeCutLines.map((p) => p.y);
    width = Math.max(...xs) - Math.min(...xs);
    height = Math.max(...ys) - Math.min(...ys);
  }

  // Extract version/generator if present
  const versionMatch = text.match(/\(version\s+(\d+)\)/);
  if (versionMatch) {
    rawProperties['version'] = versionMatch[1];
  }
  const generatorMatch = text.match(/\(generator\s+"?([^")]+)"?\)/);
  if (generatorMatch) {
    rawProperties['generator'] = generatorMatch[1];
  }

  return {
    fileName,
    format: 'kicad',
    layerCount: layers.length,
    componentCount,
    boardDimensions:
      width > 0 || height > 0
        ? { width: Math.round(width * 100) / 100, height: Math.round(height * 100) / 100, unit: 'mm' }
        : null,
    layers,
    rawProperties,
  };
}

/**
 * Parse a Gerber RS-274X file and extract metadata.
 *
 * Gerber files are per-layer, so a single file represents one layer.
 * We extract aperture definitions and basic file attributes.
 */
function parseGerber(text: string, fileName: string): PCBMetadata {
  const rawProperties: Record<string, string> = {};
  const layers: string[] = [];

  // Extract file attribute comments like %TF.FileFunction,Copper,L1,Top*%
  const attrRegex = /%TF\.(\w+),([^*]+)\*%/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(text)) !== null) {
    rawProperties[match[1]] = match[2];
    if (match[1] === 'FileFunction') {
      layers.push(match[2]);
    }
  }

  // Count aperture definitions (D-codes): %ADD\d+...
  const apertureMatches = text.match(/%ADD\d+/g);
  const componentCount = apertureMatches ? apertureMatches.length : 0;

  // Gerber files are single-layer; layer count = 1 if we detected a layer, 0 otherwise
  const layerCount = layers.length > 0 ? layers.length : 1;

  return {
    fileName,
    format: 'gerber',
    layerCount,
    componentCount,
    boardDimensions: null, // Gerber files don't embed board dimensions reliably
    layers,
    rawProperties,
  };
}

/**
 * Parse a PCB file buffer and extract metadata.
 */
export function parsePCBFile(buffer: Buffer, fileName: string): PCBMetadata {
  const format = detectFormat(fileName);
  const text = buffer.toString('utf-8');

  switch (format) {
    case 'kicad':
      return parseKicadPCB(text, fileName);
    case 'gerber':
      return parseGerber(text, fileName);
    default:
      return {
        fileName,
        format: 'unknown',
        layerCount: 0,
        componentCount: 0,
        boardDimensions: null,
        layers: [],
        rawProperties: {},
      };
  }
}

/**
 * Extract Bill of Materials from a KiCad PCB file.
 *
 * Scans footprint blocks for reference, value, and footprint library entries.
 * Deduplicates by value+footprint and sums quantities.
 */
export function extractBOM(buffer: Buffer, fileName: string): BOMEntry[] {
  const format = detectFormat(fileName);

  if (format !== 'kicad') {
    return [];
  }

  const text = buffer.toString('utf-8');
  const entries: BOMEntry[] = [];

  // Match footprint blocks: (footprint "lib:Footprint" ... (fp_text reference "R1" ...) ... (fp_text value "10k" ...))
  // We use a simpler approach: find each footprint block's reference and value
  const footprintBlockRegex =
    /\(\s*(?:footprint|module)\s+"([^"]+)"[\s\S]*?(?=\(\s*(?:footprint|module)\s+"|$)/g;
  let match: RegExpExecArray | null;

  while ((match = footprintBlockRegex.exec(text)) !== null) {
    const block = match[0];
    const footprint = match[1];

    // Extract reference (fp_text reference "R1")
    const refMatch = block.match(
      /\(\s*fp_text\s+reference\s+"([^"]+)"/,
    );
    const reference = refMatch ? refMatch[1] : '';

    // Extract value (fp_text value "10k")
    const valMatch = block.match(
      /\(\s*fp_text\s+value\s+"([^"]+)"/,
    );
    const value = valMatch ? valMatch[1] : '';

    if (reference) {
      entries.push({ reference, value, footprint, quantity: 1 });
    }
  }

  // Deduplicate by value + footprint, summing quantities
  const deduped = new Map<string, BOMEntry>();
  for (const entry of entries) {
    const key = `${entry.value}::${entry.footprint}`;
    const existing = deduped.get(key);
    if (existing) {
      existing.quantity += 1;
      // Keep first reference but could accumulate
      existing.reference = `${existing.reference}, ${entry.reference}`;
    } else {
      deduped.set(key, { ...entry });
    }
  }

  return Array.from(deduped.values());
}

export const pcbParserService = { parsePCBFile, extractBOM };
