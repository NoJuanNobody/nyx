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

export async function generateAndAttach(
  description: string,
  cluster: import('puppeteer-cluster').Cluster,
): Promise<{ html: string; screenshot: Buffer }> {
  const html = await generateMockupHTML(description);
  const screenshot = await renderToScreenshot(html, cluster);
  return { html, screenshot };
}
