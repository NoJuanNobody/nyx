/**
 * PCB Parser Service
 *
 * Handles validation and parsing of PCB design files:
 * - Gerber files (.gbr, .ger, .GTL, .GBL, .GTS, .GBS, .GTO, .GBO, .GKO, .DRL, .XLN)
 * - KiCad PCB files (.kicad_pcb)
 * - Eagle board files (.brd)
 * - Altium PCB files (.PcbDoc)
 */

export interface BomItem {
  reference: string;
  value: string;
  package: string;
  quantity: number;
}

export interface PcbMetadata {
  fileType: 'gerber' | 'kicad' | 'eagle' | 'altium' | 'other';
  layerName: string | null;
  layerType: 'copper' | 'silkscreen' | 'soldermask' | 'drill' | 'outline' | 'project' | null;
  bom?: BomItem[];
  componentCount?: number;
  boardWidthMm?: number;
  boardHeightMm?: number;
}

export interface PcbValidationResult {
  valid: boolean;
  error?: string;
  metadata?: PcbMetadata;
}

// Max 50MB for PCB file sets
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// Recognised extensions and their layer info
const GERBER_EXTENSIONS: Record<string, { layerName: string; layerType: PcbMetadata['layerType'] }> = {
  '.gtl': { layerName: 'F.Cu', layerType: 'copper' },
  '.gbl': { layerName: 'B.Cu', layerType: 'copper' },
  '.gts': { layerName: 'F.Mask', layerType: 'soldermask' },
  '.gbs': { layerName: 'B.Mask', layerType: 'soldermask' },
  '.gto': { layerName: 'F.SilkS', layerType: 'silkscreen' },
  '.gbo': { layerName: 'B.SilkS', layerType: 'silkscreen' },
  '.gko': { layerName: 'Edge.Cuts', layerType: 'outline' },
  '.gbr': { layerName: 'Gerber', layerType: 'copper' },
  '.ger': { layerName: 'Gerber', layerType: 'copper' },
  '.drl': { layerName: 'Drill', layerType: 'drill' },
  '.xln': { layerName: 'Drill', layerType: 'drill' },
  '.exc': { layerName: 'Drill', layerType: 'drill' },
};

const PCB_EXTENSIONS: Record<string, PcbMetadata['fileType']> = {
  '.kicad_pcb': 'kicad',
  '.brd': 'eagle',
  '.pcbdoc': 'altium',
};

export const pcbParserService = {
  /**
   * Validate a PCB file upload and extract metadata.
   */
  validateAndParse(filename: string, mimeType: string, buffer: Buffer): PcbValidationResult {
    if (buffer.length > MAX_FILE_SIZE) {
      return { valid: false, error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.` };
    }

    const ext = this.getExtension(filename);

    // Check Gerber extensions
    if (GERBER_EXTENSIONS[ext]) {
      const { layerName, layerType } = GERBER_EXTENSIONS[ext];
      return {
        valid: true,
        metadata: { fileType: 'gerber', layerName, layerType },
      };
    }

    // Check PCB project extensions
    const fileType = PCB_EXTENSIONS[ext];
    if (fileType) {
      const metadata = this.parsePcbProject(fileType, buffer);
      return { valid: true, metadata };
    }

    return {
      valid: false,
      error: `Unsupported PCB file type "${ext}". Supported: Gerber (.gbr, .ger, .gtl, .gbl, .gts, .gbs, .gto, .gbo, .gko, .drl), KiCad (.kicad_pcb), Eagle (.brd), Altium (.PcbDoc).`,
    };
  },

  getExtension(filename: string): string {
    // Handle multi-part extensions like .kicad_pcb
    const lower = filename.toLowerCase();
    if (lower.endsWith('.kicad_pcb')) return '.kicad_pcb';
    const dotIndex = lower.lastIndexOf('.');
    return dotIndex >= 0 ? lower.slice(dotIndex) : '';
  },

  parsePcbProject(fileType: PcbMetadata['fileType'], buffer: Buffer): PcbMetadata {
    const content = buffer.toString('utf-8');

    if (fileType === 'kicad') {
      return this.parseKicad(content);
    }
    if (fileType === 'eagle') {
      return this.parseEagle(content);
    }

    return { fileType, layerName: null, layerType: 'project' };
  },

  /**
   * Parse a KiCad .kicad_pcb S-expression file.
   * Extracts board dimensions and component BOM.
   */
  parseKicad(content: string): PcbMetadata {
    const bom = new Map<string, BomItem>();

    // Extract footprint entries: (footprint "..." ... (property "Reference" "R1") (property "Value" "10k") ...)
    const footprintRegex = /\(footprint\s+"([^"]+)"[^)]*\(layer\s+"([^"]+)"\)/g;
    const refRegex = /\(property\s+"Reference"\s+"([^"]+)"\)/g;
    const valueRegex = /\(property\s+"Value"\s+"([^"]+)"\)/g;

    // Simpler approach: find all component blocks
    const componentMatches = [...content.matchAll(/\(footprint\s+"([^"]+)"([\s\S]*?)(?=\n\s*\(footprint|\n\s*\(gr_)/g)];

    for (const match of componentMatches) {
      const packageName = match[1];
      const block = match[2];

      const refMatch = block.match(/\(property\s+"Reference"\s+"([^"]+)"\)/);
      const valMatch = block.match(/\(property\s+"Value"\s+"([^"]+)"\)/);

      if (refMatch) {
        const reference = refMatch[1];
        const value = valMatch?.[1] ?? '';
        const key = `${value}:${packageName}`;

        const existing = bom.get(key);
        if (existing) {
          existing.quantity += 1;
          existing.reference += `, ${reference}`;
        } else {
          bom.set(key, { reference, value, package: packageName, quantity: 1 });
        }
      }
    }

    // Try to extract board outline dimensions from gr_rect or gr_line on Edge.Cuts
    let boardWidthMm: number | undefined;
    let boardHeightMm: number | undefined;

    const rectMatch = content.match(/\(gr_rect\s+\(start\s+([\d.]+)\s+([\d.]+)\)\s+\(end\s+([\d.]+)\s+([\d.]+)\)[^)]*"Edge\.Cuts"/);
    if (rectMatch) {
      boardWidthMm = Math.abs(parseFloat(rectMatch[3]) - parseFloat(rectMatch[1]));
      boardHeightMm = Math.abs(parseFloat(rectMatch[4]) - parseFloat(rectMatch[2]));
    }

    const bomItems = [...bom.values()];
    return {
      fileType: 'kicad',
      layerName: null,
      layerType: 'project',
      bom: bomItems,
      componentCount: bomItems.reduce((sum, item) => sum + item.quantity, 0),
      boardWidthMm,
      boardHeightMm,
    };
  },

  /**
   * Parse an Eagle .brd XML file.
   * Extracts component BOM from <elements> section.
   */
  parseEagle(content: string): PcbMetadata {
    const bom = new Map<string, BomItem>();

    // Eagle BRD files are XML; extract <element> tags
    const elementRegex = /<element\s+name="([^"]+)"\s+library="([^"]*)"\s+package="([^"]*)"\s+value="([^"]*)"/g;
    let match: RegExpExecArray | null;

    while ((match = elementRegex.exec(content)) !== null) {
      const reference = match[1];
      const packageName = match[3];
      const value = match[4];
      const key = `${value}:${packageName}`;

      const existing = bom.get(key);
      if (existing) {
        existing.quantity += 1;
        existing.reference += `, ${reference}`;
      } else {
        bom.set(key, { reference, value, package: packageName, quantity: 1 });
      }
    }

    const bomItems = [...bom.values()];
    return {
      fileType: 'eagle',
      layerName: null,
      layerType: 'project',
      bom: bomItems,
      componentCount: bomItems.reduce((sum, item) => sum + item.quantity, 0),
    };
  },
};
