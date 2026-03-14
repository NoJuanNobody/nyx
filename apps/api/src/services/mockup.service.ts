// AI UI Mockup generation service
// Generates HTML mockups via Claude API, renders to PNG via Puppeteer Cluster

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

const MOCKUP_SYSTEM_PROMPT = `You are a UI mockup generator. Given a description of a UI component or page, generate self-contained HTML with inline CSS that represents a realistic mockup. Requirements:
- Use a clean, modern design with a professional color palette
- All styles must be inline CSS or in a <style> tag — no external stylesheets
- The viewport is fixed at 1280x800
- Use system fonts (sans-serif)
- Include realistic placeholder content
- Output ONLY the HTML — no markdown, no code fences, no explanation`;

export async function generateMockupHTML(description: string): Promise<string> {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: MOCKUP_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: description }],
  });

  const textBlock = message.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('AI did not return text content');
  }

  return textBlock.text;
}

export async function renderToScreenshot(
  html: string,
  cluster: import('puppeteer-cluster').Cluster,
): Promise<Buffer> {
  const screenshot = await cluster.execute(html, async ({ page, data: htmlContent }) => {
    await page.setViewport({ width: 1280, height: 800 });
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    const buffer = await page.screenshot({ type: 'png', fullPage: false });
    return Buffer.from(buffer);
  });

  return screenshot;
}

export async function renderJSXToScreenshot(
  jsx: string,
  cluster: import('puppeteer-cluster').Cluster,
): Promise<Buffer> {
  // Wrap the JSX in a full HTML page with React + Tailwind CDN
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; }</style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel" data-presets="react,typescript">
    const { useState, useEffect, useRef, useCallback, useMemo, useReducer, useContext, createContext, Fragment } = React;
    ${jsx.replace(/^\s*import\s+.*$/gm, '').replace(/^\s*export\s+default\s+/gm, '').replace(/^\s*export\s+(?=function|const|class)/gm, '')}
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(React.createElement(typeof App !== 'undefined' ? App : () => React.createElement('div', null, 'No App component found')));
  </script>
</body>
</html>`;

  return renderToScreenshot(html, cluster);
}

export async function generateAndAttach(
  description: string,
  cluster: import('puppeteer-cluster').Cluster,
): Promise<{ html: string; screenshot: Buffer }> {
  const html = await generateMockupHTML(description);
  const screenshot = await renderToScreenshot(html, cluster);
  return { html, screenshot };
}
