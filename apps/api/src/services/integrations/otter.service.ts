/**
 * Otter.ai integration service.
 *
 * Wraps the Otter.ai REST API to list speeches (transcripts) and fetch their
 * full text content.  API surface is intentionally minimal — we only fetch what
 * we need to import a transcript into the Nyx pipeline.
 *
 * Otter.ai API reference: https://otter.ai/developers
 *   OAuth:  POST https://otter.ai/oauth/token
 *   Speeches: GET https://api.otter.ai/v2/speeches
 *             GET https://api.otter.ai/v2/speeches/{speech_id}
 */

const OTTER_API_BASE = 'https://api.otter.ai/v2';
const OTTER_OAUTH_TOKEN_URL = 'https://otter.ai/oauth/token';
const OTTER_OAUTH_AUTHORIZE_URL = 'https://otter.ai/oauth/authorize';

export { OTTER_OAUTH_AUTHORIZE_URL, OTTER_OAUTH_TOKEN_URL };

// ── Otter API shapes ──────────────────────────────────────────────────────────

export interface OtterSpeechSummary {
  speech_id: string;
  title: string;
  create_time: number; // Unix timestamp (seconds)
  start_time: string;  // ISO-8601
  end_time: string;    // ISO-8601
  duration: number;    // seconds
}

export interface OtterTranscriptSegment {
  transcript_id: string;
  spk_id: number;
  spk_labels: string[];
  text: string;
  start_offset: number; // seconds from meeting start
  end_offset: number;
}

export interface OtterSpeech extends OtterSpeechSummary {
  transcripts: OtterTranscriptSegment[];
}

export interface OtterListResponse {
  speeches: OtterSpeechSummary[];
}

export interface OtterTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

// ── Token exchange ────────────────────────────────────────────────────────────

export async function exchangeCodeForToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<OtterTokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetch(OTTER_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown error');
    throw new Error(`Otter.ai token exchange failed (${response.status}): ${body}`);
  }

  return (await response.json()) as OtterTokenResponse;
}

// ── API helpers ───────────────────────────────────────────────────────────────

function bearerHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
}

// ── Service methods ───────────────────────────────────────────────────────────

/**
 * List recent Otter.ai speeches for the authenticated user.
 * @param accessToken  OAuth access token
 * @param limit        Max number to return (default 20)
 * @param query        Optional title filter applied client-side
 */
export async function listTranscripts(
  accessToken: string,
  limit = 20,
  query?: string,
): Promise<OtterSpeechSummary[]> {
  const url = new URL(`${OTTER_API_BASE}/speeches`);
  url.searchParams.set('page_size', String(limit));

  const response = await fetch(url.toString(), {
    headers: bearerHeaders(accessToken),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown');
    throw new Error(`Otter.ai list speeches failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as OtterListResponse;
  const speeches = data.speeches ?? [];

  if (query) {
    const q = query.toLowerCase();
    return speeches.filter((s) => s.title.toLowerCase().includes(q));
  }

  return speeches;
}

/**
 * Fetch a single Otter.ai speech including its transcript segments.
 */
export async function getSpeech(
  accessToken: string,
  speechId: string,
): Promise<OtterSpeech> {
  const response = await fetch(`${OTTER_API_BASE}/speeches/${encodeURIComponent(speechId)}`, {
    headers: bearerHeaders(accessToken),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown');
    throw new Error(`Otter.ai get speech failed (${response.status}): ${body}`);
  }

  return (await response.json()) as OtterSpeech;
}

/**
 * Convert an Otter speech's transcript segments into a plain-text string
 * suitable for passing to `semanticParserService.parseTranscript()`.
 *
 * Output format:
 *   Speaker Name: sentence text
 *   Another Speaker: next sentence
 *   ...
 */
export function transcriptToPlainText(speech: OtterSpeech): string {
  if (!speech.transcripts || speech.transcripts.length === 0) {
    return '';
  }

  return speech.transcripts
    .map((segment) => {
      const speaker = segment.spk_labels?.[segment.spk_id] ?? `Speaker ${segment.spk_id + 1}`;
      return `${speaker}: ${segment.text.trim()}`;
    })
    .join('\n');
}

export const otterService = {
  exchangeCodeForToken,
  listTranscripts,
  getSpeech,
  transcriptToPlainText,
};
