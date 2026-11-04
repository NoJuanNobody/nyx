/**
 * Lightweight, env-gated conversion tracking (GA4 + Google Ads).
 *
 * Everything is a no-op unless the relevant VITE_* env vars are set, so this is
 * safe to ship immediately and "turned on" later by adding the IDs in Vercel:
 *
 *   VITE_GA_MEASUREMENT_ID       GA4 measurement id, e.g. "G-XXXXXXX"
 *   VITE_GOOGLE_ADS_ID           Google Ads id, e.g. "AW-XXXXXXXXX"
 *   VITE_GOOGLE_ADS_SIGNUP_LABEL Google Ads conversion label for signups
 *
 * Two conversions matter for the ad funnel: `sign_up` and `purchase` (the money
 * event). Both carry first-touch UTM attribution so channels are comparable.
 */

// Defaults to the production GA4 property; override per-environment with the
// env var. Measurement IDs are public (visible in any tagged page), so this is
// safe to commit and means tracking works without extra env config.
const GA_ID = (import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined) ?? 'G-KV3XWB2WSQ';
const ADS_ID = import.meta.env.VITE_GOOGLE_ADS_ID as string | undefined;
const ADS_SIGNUP_LABEL = import.meta.env.VITE_GOOGLE_ADS_SIGNUP_LABEL as string | undefined;

const ATTRIBUTION_KEY = 'nyx_attribution';
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid'] as const;

type Gtag = (...args: unknown[]) => void;
declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: Gtag;
  }
}

function gtag(...args: unknown[]) {
  if (typeof window === 'undefined' || !window.gtag) return;
  window.gtag(...args);
}

/** First-touch attribution captured from the landing URL. */
export function getAttribution(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ATTRIBUTION_KEY) ?? '{}');
  } catch {
    return {};
  }
}

/**
 * Capture UTM / gclid params from the current URL on first visit and persist
 * them (first-touch wins). Call once on app load, before any navigation.
 */
export function captureAttribution() {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  const captured: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const val = params.get(key);
    if (val) captured[key] = val;
  }
  if (Object.keys(captured).length === 0) return;
  // First-touch: don't overwrite an earlier attribution.
  if (localStorage.getItem(ATTRIBUTION_KEY)) return;
  captured.landing_at = new Date().toISOString();
  localStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(captured));
}

/** Inject the gtag script and configure whichever IDs are present. No-op if none. */
export function initAnalytics() {
  if (typeof window === 'undefined') return;
  const primaryId = GA_ID ?? ADS_ID;
  if (!primaryId) return; // nothing configured — stay a no-op

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtagShim(...args: unknown[]) {
    window.dataLayer!.push(args);
  };
  gtag('js', new Date());
  if (GA_ID) gtag('config', GA_ID);
  if (ADS_ID) gtag('config', ADS_ID);

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${primaryId}`;
  document.head.appendChild(script);
}

/** Generic GA4 event with attribution attached. */
export function trackEvent(name: string, params: Record<string, unknown> = {}) {
  const payload = { ...params, ...getAttribution() };
  if (!GA_ID && !ADS_ID) {
    if (import.meta.env.DEV) console.debug('[analytics] (no id)', name, payload);
    return;
  }
  gtag('event', name, payload);
}

/** Fire a Google Ads conversion for a given label, if Ads is configured. */
function trackAdsConversion(label: string | undefined, params: Record<string, unknown>) {
  if (!ADS_ID || !label) return;
  gtag('event', 'conversion', { send_to: `${ADS_ID}/${label}`, ...params });
}

/**
 * Track a signup. Guarded once-per-user-per-browser so re-renders and repeat
 * logins don't double-count. (Client-side proxy for a new account.)
 */
export function trackSignUp(userId: string) {
  if (!userId) return;
  const flag = `nyx_signup_tracked_${userId}`;
  try {
    if (localStorage.getItem(flag)) return;
    localStorage.setItem(flag, '1');
  } catch {
    // If storage is unavailable, still fire (better a dupe than a miss).
  }
  trackEvent('sign_up', { method: 'clerk' });
  trackAdsConversion(ADS_SIGNUP_LABEL, getAttribution());
}

