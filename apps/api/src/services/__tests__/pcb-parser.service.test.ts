import { describe, it, expect } from 'vitest';
import { parsePCBFile, extractBOM } from '../pcb-parser.service.js';

// ── Sample KiCad PCB content ────────────────────────────────────────

const KICAD_PCB_SAMPLE = `
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
`;

// ── Sample Gerber content ───────────────────────────────────────────

const GERBER_SAMPLE = `
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
`;

// ── Tests ───────────────────────────────────────────────────────────

describe('pcbParserService', () => {
  describe('parsePCBFile', () => {
    describe('KiCad format', () => {
      it('should detect kicad format from .kicad_pcb extension', () => {
        const buffer = Buffer.from(KICAD_PCB_SAMPLE);
        const result = parsePCBFile(buffer, 'board.kicad_pcb');
        expect(result.format).toBe('kicad');
        expect(result.fileName).toBe('board.kicad_pcb');
      });

      it('should extract layer count and layer names', () => {
        const buffer = Buffer.from(KICAD_PCB_SAMPLE);
        const result = parsePCBFile(buffer, 'board.kicad_pcb');
        expect(result.layerCount).toBe(7);
        expect(result.layers).toContain('F.Cu');
        expect(result.layers).toContain('B.Cu');
        expect(result.layers).toContain('Edge.Cuts');
      });

      it('should count components from footprint blocks', () => {
        const buffer = Buffer.from(KICAD_PCB_SAMPLE);
        const result = parsePCBFile(buffer, 'board.kicad_pcb');
        expect(result.componentCount).toBe(4);
      });

      it('should extract board dimensions from Edge.Cuts gr_lines', () => {
        const buffer = Buffer.from(KICAD_PCB_SAMPLE);
        const result = parsePCBFile(buffer, 'board.kicad_pcb');
        expect(result.boardDimensions).not.toBeNull();
        expect(result.boardDimensions!.width).toBe(50);
        expect(result.boardDimensions!.height).toBe(30);
        expect(result.boardDimensions!.unit).toBe('mm');
      });

      it('should extract version and generator from raw properties', () => {
        const buffer = Buffer.from(KICAD_PCB_SAMPLE);
        const result = parsePCBFile(buffer, 'board.kicad_pcb');
        expect(result.rawProperties['version']).toBe('20221018');
        expect(result.rawProperties['generator']).toBe('pcbnew');
      });

      it('should handle KiCad file with no edge cuts (null dimensions)', () => {
        const minimal = `
(kicad_pcb (version 20221018) (generator "pcbnew")
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
  )
)`;
        const buffer = Buffer.from(minimal);
        const result = parsePCBFile(buffer, 'minimal.kicad_pcb');
        expect(result.boardDimensions).toBeNull();
        expect(result.layerCount).toBe(2);
        expect(result.componentCount).toBe(0);
      });
    });

    describe('Gerber format', () => {
      it('should detect gerber format from .gbr extension', () => {
        const buffer = Buffer.from(GERBER_SAMPLE);
        const result = parsePCBFile(buffer, 'top_copper.gbr');
        expect(result.format).toBe('gerber');
        expect(result.fileName).toBe('top_copper.gbr');
      });

      it('should detect gerber format from other gerber extensions', () => {
        const extensions = ['gbl', 'gtl', 'gbs', 'gts', 'gbo', 'gto'];
        for (const ext of extensions) {
          const buffer = Buffer.from(GERBER_SAMPLE);
          const result = parsePCBFile(buffer, `layer.${ext}`);
          expect(result.format).toBe('gerber');
        }
      });

      it('should extract file attributes from Gerber TF comments', () => {
        const buffer = Buffer.from(GERBER_SAMPLE);
        const result = parsePCBFile(buffer, 'top_copper.gbr');
        expect(result.rawProperties['FileFunction']).toBe('Copper,L1,Top');
        expect(result.rawProperties['FilePolarity']).toBe('Positive');
      });

      it('should extract layer info from FileFunction attribute', () => {
        const buffer = Buffer.from(GERBER_SAMPLE);
        const result = parsePCBFile(buffer, 'top_copper.gbr');
        expect(result.layers).toContain('Copper,L1,Top');
      });

      it('should count aperture definitions', () => {
        const buffer = Buffer.from(GERBER_SAMPLE);
        const result = parsePCBFile(buffer, 'top_copper.gbr');
        expect(result.componentCount).toBe(3); // ADD10, ADD11, ADD12
      });

      it('should return null board dimensions for Gerber files', () => {
        const buffer = Buffer.from(GERBER_SAMPLE);
        const result = parsePCBFile(buffer, 'top_copper.gbr');
        expect(result.boardDimensions).toBeNull();
      });
    });

    describe('unknown format', () => {
      it('should return unknown format for unsupported extensions', () => {
        const buffer = Buffer.from('some random content');
        const result = parsePCBFile(buffer, 'design.eagle');
        expect(result.format).toBe('unknown');
        expect(result.layerCount).toBe(0);
        expect(result.componentCount).toBe(0);
        expect(result.layers).toEqual([]);
      });

      it('should handle empty buffer gracefully', () => {
        const buffer = Buffer.from('');
        const result = parsePCBFile(buffer, 'empty.kicad_pcb');
        expect(result.format).toBe('kicad');
        expect(result.layerCount).toBe(0);
        expect(result.componentCount).toBe(0);
        expect(result.boardDimensions).toBeNull();
      });
    });
  });

  describe('extractBOM', () => {
    it('should extract BOM entries from KiCad file', () => {
      const buffer = Buffer.from(KICAD_PCB_SAMPLE);
      const bom = extractBOM(buffer, 'board.kicad_pcb');
      expect(bom.length).toBeGreaterThan(0);
    });

    it('should deduplicate components by value and footprint', () => {
      const buffer = Buffer.from(KICAD_PCB_SAMPLE);
      const bom = extractBOM(buffer, 'board.kicad_pcb');

      // R1 and R2 are both 10k with same footprint — should be merged
      const resistor = bom.find((e) => e.value === '10k');
      expect(resistor).toBeDefined();
      expect(resistor!.quantity).toBe(2);
      expect(resistor!.footprint).toBe('Resistor_SMD:R_0402_1005Metric');
    });

    it('should keep different components separate', () => {
      const buffer = Buffer.from(KICAD_PCB_SAMPLE);
      const bom = extractBOM(buffer, 'board.kicad_pcb');

      const cap = bom.find((e) => e.value === '100nF');
      expect(cap).toBeDefined();
      expect(cap!.quantity).toBe(1);

      const ic = bom.find((e) => e.value === 'ATtiny85');
      expect(ic).toBeDefined();
      expect(ic!.quantity).toBe(1);
    });

    it('should return empty array for non-KiCad files', () => {
      const buffer = Buffer.from(GERBER_SAMPLE);
      const bom = extractBOM(buffer, 'layer.gbr');
      expect(bom).toEqual([]);
    });

    it('should return empty array for unknown formats', () => {
      const buffer = Buffer.from('random content');
      const bom = extractBOM(buffer, 'file.txt');
      expect(bom).toEqual([]);
    });

    it('should handle KiCad file with no footprints', () => {
      const minimal = `
(kicad_pcb (version 20221018) (generator "pcbnew")
  (layers (0 "F.Cu" signal))
)`;
      const buffer = Buffer.from(minimal);
      const bom = extractBOM(buffer, 'empty.kicad_pcb');
      expect(bom).toEqual([]);
    });

    it('should include reference designators in deduplicated entries', () => {
      const buffer = Buffer.from(KICAD_PCB_SAMPLE);
      const bom = extractBOM(buffer, 'board.kicad_pcb');

      const resistor = bom.find((e) => e.value === '10k');
      expect(resistor).toBeDefined();
      // Both R1 and R2 should be referenced
      expect(resistor!.reference).toContain('R1');
      expect(resistor!.reference).toContain('R2');
    });
  });
});
