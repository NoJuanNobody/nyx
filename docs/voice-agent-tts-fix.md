# Voice Agent TTS Fix — Feature Doc & Implementation Plan

**Issue:** #251
**Status:** Ready for implementation
**Scope:** `apps/api/src/services/voice/`

---

## Problem Summary

The Nyx voice agent joins meetings and processes transcripts correctly, but responses are silently posted as text chat messages rather than spoken aloud. From a participant's perspective, the agent is invisible: no audio, just an occasional chat sidebar message that most people ignore during a live call.

There are four distinct bugs contributing to this:

1. **Wrong output method** — `voice-agent.service.ts:99` calls `sendChat()` instead of `speak()`
2. **Missing TTS provider** — `recall-adapter.ts:64-86` creates the Recall.ai bot without configuring a TTS provider, so even `speak()` → `sendOutputAudio()` would fail silently on the Recall.ai side
3. **Silent error swallowing** — the catch block at `voice-agent.service.ts:98-102` discards all errors with no logging
4. **Fragile name detection** — the agent relies entirely on Claude returning `__SKIP__` with no explicit pre-filter, so edge cases (mumbled "Nyx", "hey nix", typos) are silently dropped

---

## Current Code Paths

```
voice-agent.service.ts
  processTranscript()
    → ai.messages.create()          // Claude generates response
    → callIntegrationService.sendChat()   // ❌ posts text to chat sidebar
    catch { /* silent */ }          // ❌ swallows all errors

callIntegrationService.speak()      // ✅ exists, never called
  → connection.speak()
    → recall-adapter.ts sendOutputAudio()  // calls /output_audio
    // ❌ bot was created without a TTS provider, so Recall.ai rejects this
```

### What Recall.ai `output_audio` requires

Recall.ai's `/bot/{id}/output_audio` endpoint with `kind: "text"` requires the bot to have been created with a `real_time_media` TTS provider config. Without it, the request returns a `400` or `422` and the audio is never synthesized. The current `createBot()` function in `recall-adapter.ts` sets `output_media` (for video/speaker defaults) but omits the `real_time_media.speaker` TTS block entirely.

---

## Acceptance Criteria

- [ ] Voice agent calls `speak()` instead of `sendChat()` to deliver responses as spoken audio
- [ ] Recall.ai bot creation includes a TTS provider in `real_time_media.speaker`
- [ ] Errors around the send call are logged, not silently swallowed
- [ ] Consider explicit name pre-filter as a guard before Claude inference

---

## Implementation Plan

### Step 1 — Switch `sendChat` → `speak` in voice-agent.service.ts

**File:** `apps/api/src/services/voice/voice-agent.service.ts`
**Lines:** 97–102

```ts
// Before
try {
  await callIntegrationService.sendChat(state.sessionId, text);
} catch {
  // Session may have ended
}

// After
try {
  await callIntegrationService.speak(state.sessionId, text);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[VoiceAgent:${state.sessionId.slice(0, 8)}] speak() failed: ${msg}`);
}
```

This is the minimum fix: routes output through the correct method. The `speak()` method on `callIntegrationService` already correctly emits a `bot_output` event with `type: 'tts'` and delegates to `connection.speak()` → `sendOutputAudio()`.

---

### Step 2 — Add TTS provider to Recall.ai bot config

**File:** `apps/api/src/services/voice/recall-adapter.ts`
**Function:** `createBot()` (line 64)

Recall.ai requires `real_time_media.speaker` to be set for the `output_audio` endpoint to synthesize speech. The provider field accepts several options; the recommended ones are:

| Provider | Recall.ai config key | Requirements |
|---|---|---|
| ElevenLabs | `eleven_labs` | `ELEVEN_LABS_API_KEY` env var |
| Azure TTS | `azure_cognitive_services` | Azure key + region |
| AWS Polly | `aws_polly` | AWS credentials |
| Play.ht | `play_ht` | API key + user ID |

For MVP, **ElevenLabs** is the recommended choice because:
- Recall.ai's docs show it as the primary example
- Good voice quality out of the box
- Simple API key auth (single env var)

The bot config change:

```ts
// recall-adapter.ts — createBot()
const botConfig: Record<string, unknown> = {
  meeting_url: meetingUrl,
  output_media: {
    camera: { kind: 'default' },
    speaker: { kind: 'default' },
  },
};

// Add TTS provider when key is available
const elevenLabsKey = process.env.ELEVEN_LABS_API_KEY;
if (elevenLabsKey) {
  botConfig.real_time_media = {
    speaker: {
      provider: {
        eleven_labs: {
          api_key: elevenLabsKey,
          // Optional: specify a voice ID. Defaults to ElevenLabs default voice.
          // voice_id: process.env.ELEVEN_LABS_VOICE_ID,
        },
      },
    },
  };
  console.log('[Recall] TTS provider: ElevenLabs');
} else {
  console.warn(
    '[Recall] ELEVEN_LABS_API_KEY not set — output_audio (TTS) will not work. ' +
    'Set ELEVEN_LABS_API_KEY to enable spoken responses.',
  );
}
```

**Why conditional?** Keeping the bot joinable even without TTS configured allows dev/CI environments to still test the join flow. The warning surfaces the missing config clearly instead of silently failing downstream.

---

### Step 3 — Add explicit name detection pre-filter (optional but recommended)

**File:** `apps/api/src/services/voice/voice-agent.service.ts`
**Function:** `processTranscript()`

Currently the full buffered transcript is sent to Claude on every debounce tick, relying entirely on the `__SKIP__` instruction. This has two downsides:
- Every pause in conversation fires a Claude API call (cost)
- Edge cases like "hey nix" or a mumbled "nyx" are silently dropped

A lightweight local pre-filter before the API call:

```ts
/** Returns true if the transcript chunk likely addresses the bot by name. */
function mentionsAgent(text: string): boolean {
  // Case-insensitive, allows common mishearings / typos
  return /\b(nyx|nix|nicks|nex)\b/i.test(text);
}

async function processTranscript(state: AgentState): Promise<void> {
  // ... existing guards ...

  const bufferedText = state.transcriptBuffer.join('\n');
  if (bufferedText.length < MIN_BUFFER_LENGTH) return;

  // Fast path: skip Claude call entirely if no name mention
  if (!mentionsAgent(bufferedText)) {
    state.processing = false; // (or just return before setting it)
    return;
  }

  // ... rest of Claude call ...
}
```

This is optional but recommended because it:
- Reduces unnecessary Claude API calls by ~90%+ (most meeting chatter doesn't mention Nyx)
- Still lets Claude do the final judgment on whether the message is a real question vs. passing mention
- Handles common phonetic variants without changing the prompt

---

### Step 4 — Environment variable additions

Add to your `.env.example` / deployment config:

```
# Required for voice agent spoken responses
ELEVEN_LABS_API_KEY=your_elevenlabs_api_key_here

# Optional: specific ElevenLabs voice ID (defaults to ElevenLabs default)
# ELEVEN_LABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
```

If using a different TTS provider, substitute accordingly. The `RECALL_WEBHOOK_URL` env var already exists in the adapter and should also be set for real-time transcript delivery (vs. polling).

---

### Step 5 — Test coverage

**File:** `apps/api/src/services/voice/__tests__/` (new or extended)

Tests to add:

```
voice-agent.service.test.ts
  ✓ calls speak() not sendChat() when agent generates a response
  ✓ logs error when speak() throws (does not swallow silently)
  ✓ skips Claude call when buffered text has no agent name mention
  ✓ still calls Claude when "nix" or "nyx" appears in transcript

recall-adapter.test.ts
  ✓ bot creation includes real_time_media.speaker when ELEVEN_LABS_API_KEY is set
  ✓ bot creation logs a warning and omits real_time_media when key is missing
```

---

## Minimal Change Summary (Priority Order)

| # | File | Change | Risk |
|---|---|---|---|
| 1 | `voice-agent.service.ts:99` | `sendChat` → `speak` | Low — one line, method exists |
| 2 | `voice-agent.service.ts:100-102` | Add `console.error` to catch | Low — pure logging |
| 3 | `recall-adapter.ts:67-86` | Add `real_time_media.speaker` to bot config | Medium — Recall.ai config |
| 4 | `voice-agent.service.ts` | Add `mentionsAgent()` pre-filter | Low — additive guard |
| 5 | `.env.example` | Document `ELEVEN_LABS_API_KEY` | Trivial |

Steps 1 and 2 can be shipped immediately with zero external dependencies. Step 3 requires an ElevenLabs (or equivalent) API key and a Recall.ai account that supports TTS. Step 4 is a pure code improvement.

---

## Architecture Notes

- `speak()` on `callIntegrationService` already emits a `bot_output` event with `type: 'tts'` (line 261–272 of `call-integration.service.ts`). Any listener on the event bus will automatically see spoken responses separately from chat messages — no event schema changes needed.
- The `stubAdapter` used in dev/tests already has a no-op `speak()` implementation (line 99–101 of `call-integration.service.ts`), so tests won't break.
- `tts.service.ts` uses OpenAI TTS for podcast generation — this is unrelated and should not be repurposed here. Recall.ai handles TTS synthesis server-side via the configured provider; the API only sends text.

---

## Open Questions

1. **Which TTS provider?** ElevenLabs is recommended but requires a paid account. Azure Cognitive Services or AWS Polly may be preferable if the team already has those credentials. The code change is identical — only the config key in `real_time_media.speaker.provider` changes.

2. **Voice ID?** ElevenLabs supports custom voices. Consider creating a "Nyx" branded voice for product consistency. For MVP, the default voice is fine.

3. **Fallback to chat?** Should the agent fall back to `sendChat()` if `speak()` fails (e.g., no TTS key configured)? Current plan: log the error and stay silent rather than confusingly posting a chat message when audio was expected. This can be made configurable.
