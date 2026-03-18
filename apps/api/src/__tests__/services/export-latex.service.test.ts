import { describe, it, expect } from 'vitest';
import { markdownToLatex, isValidTheme } from '../../services/export-latex.service.js';

describe('markdownToLatex', () => {
  describe('headings', () => {
    it('converts h1 to \\section', () => {
      const result = markdownToLatex('# Introduction', 'plain');
      expect(result).toContain('\\section{Introduction}');
    });

    it('converts h2 to \\subsection', () => {
      const result = markdownToLatex('## Methods', 'plain');
      expect(result).toContain('\\subsection{Methods}');
    });

    it('converts h3 to \\subsubsection', () => {
      const result = markdownToLatex('### Details', 'plain');
      expect(result).toContain('\\subsubsection{Details}');
    });

    it('converts h4 to \\paragraph', () => {
      const result = markdownToLatex('#### Minor Point', 'plain');
      expect(result).toContain('\\paragraph{Minor Point}');
    });
  });

  describe('inline formatting', () => {
    it('converts bold text', () => {
      const result = markdownToLatex('This is **bold** text', 'plain');
      expect(result).toContain('\\textbf{bold}');
    });

    it('converts italic text', () => {
      const result = markdownToLatex('This is *italic* text', 'plain');
      expect(result).toContain('\\textit{italic}');
    });

    it('converts bold+italic text', () => {
      const result = markdownToLatex('This is ***bold italic*** text', 'plain');
      expect(result).toContain('\\textbf{\\textit{bold italic}}');
    });

    it('converts inline code', () => {
      const result = markdownToLatex('Use `console.log()` here', 'plain');
      expect(result).toContain('\\texttt{console.log()}');
    });
  });

  describe('code blocks', () => {
    it('converts fenced code blocks to lstlisting', () => {
      const md = '```python\nprint("hello")\n```';
      const result = markdownToLatex(md, 'plain');
      expect(result).toContain('\\begin{lstlisting}[language=python]');
      expect(result).toContain('print("hello")');
      expect(result).toContain('\\end{lstlisting}');
    });

    it('handles code blocks without language', () => {
      const md = '```\nsome code\n```';
      const result = markdownToLatex(md, 'plain');
      expect(result).toContain('\\begin{lstlisting}');
      expect(result).not.toContain('[language=]');
      expect(result).toContain('some code');
      expect(result).toContain('\\end{lstlisting}');
    });
  });

  describe('tables', () => {
    it('converts markdown tables to tabular', () => {
      const md = `| Name | Value |
| --- | --- |
| Alpha | 1 |
| Beta | 2 |`;
      const result = markdownToLatex(md, 'plain');
      expect(result).toContain('\\begin{tabular}');
      expect(result).toContain('Name & Value');
      expect(result).toContain('Alpha & 1');
      expect(result).toContain('Beta & 2');
      expect(result).toContain('\\end{tabular}');
      expect(result).toContain('\\hline');
    });
  });

  describe('lists', () => {
    it('converts unordered lists', () => {
      const md = '- Item one\n- Item two\n- Item three';
      const result = markdownToLatex(md, 'plain');
      expect(result).toContain('\\begin{itemize}');
      expect(result).toContain('\\item Item one');
      expect(result).toContain('\\item Item two');
      expect(result).toContain('\\item Item three');
      expect(result).toContain('\\end{itemize}');
    });

    it('converts ordered lists', () => {
      const md = '1. First\n2. Second\n3. Third';
      const result = markdownToLatex(md, 'plain');
      expect(result).toContain('\\begin{enumerate}');
      expect(result).toContain('\\item First');
      expect(result).toContain('\\item Second');
      expect(result).toContain('\\item Third');
      expect(result).toContain('\\end{enumerate}');
    });
  });

  describe('math pass-through', () => {
    it('passes through display math ($$)', () => {
      const md = '$$E = mc^2$$';
      const result = markdownToLatex(md, 'plain');
      expect(result).toContain('\\[E = mc^2\\]');
    });

    it('passes through multi-line display math', () => {
      const md = '$$\nx = \\frac{-b}{2a}\n$$';
      const result = markdownToLatex(md, 'plain');
      expect(result).toContain('\\[');
      expect(result).toContain('x = \\frac{-b}{2a}');
      expect(result).toContain('\\]');
    });
  });

  describe('themes', () => {
    it('uses IEEE preamble for ieee theme', () => {
      const result = markdownToLatex('# Test', 'ieee');
      expect(result).toContain('\\documentclass[conference]{IEEEtran}');
    });

    it('uses ACM preamble for acm theme', () => {
      const result = markdownToLatex('# Test', 'acm');
      expect(result).toContain('\\documentclass[sigconf]{acmart}');
    });

    it('uses APA preamble for apa theme', () => {
      const result = markdownToLatex('# Test', 'apa');
      expect(result).toContain('\\documentclass[man,12pt]{apa7}');
    });

    it('uses plain article preamble for plain theme', () => {
      const result = markdownToLatex('# Test', 'plain');
      expect(result).toContain('\\documentclass[12pt]{article}');
    });

    it('defaults to plain theme when no theme specified', () => {
      const result = markdownToLatex('# Test');
      expect(result).toContain('\\documentclass[12pt]{article}');
    });

    it('wraps content in document environment', () => {
      const result = markdownToLatex('Hello world', 'plain');
      expect(result).toContain('\\begin{document}');
      expect(result).toContain('\\end{document}');
    });
  });

  describe('special characters', () => {
    it('escapes ampersands in text', () => {
      const result = markdownToLatex('R&D department', 'plain');
      expect(result).toContain('R\\&D department');
    });
  });

  describe('combined document', () => {
    it('converts a full document correctly', () => {
      const md = `# Research Paper

## Abstract

This paper explores **important** topics in *science*.

## Methods

We used the following approach:

1. Collect data
2. Analyze results
3. Draw conclusions

$$E = mc^2$$

\`\`\`python
import numpy as np
data = np.array([1, 2, 3])
\`\`\`

| Metric | Value |
| --- | --- |
| Accuracy | 95% |`;

      const result = markdownToLatex(md, 'ieee');
      expect(result).toContain('\\documentclass[conference]{IEEEtran}');
      expect(result).toContain('\\begin{document}');
      expect(result).toContain('\\section{Research Paper}');
      expect(result).toContain('\\subsection{Abstract}');
      expect(result).toContain('\\textbf{important}');
      expect(result).toContain('\\textit{science}');
      expect(result).toContain('\\begin{enumerate}');
      expect(result).toContain('\\[E = mc^2\\]');
      expect(result).toContain('\\begin{lstlisting}[language=python]');
      expect(result).toContain('\\begin{tabular}');
      expect(result).toContain('\\end{document}');
    });
  });
});

describe('isValidTheme', () => {
  it('returns true for valid themes', () => {
    expect(isValidTheme('ieee')).toBe(true);
    expect(isValidTheme('acm')).toBe(true);
    expect(isValidTheme('apa')).toBe(true);
    expect(isValidTheme('plain')).toBe(true);
  });

  it('returns false for invalid themes', () => {
    expect(isValidTheme('invalid')).toBe(false);
    expect(isValidTheme('')).toBe(false);
    expect(isValidTheme('IEEE')).toBe(false);
  });
});
