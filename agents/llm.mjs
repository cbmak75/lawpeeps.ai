/**
 * llm.mjs -- Shared Gemini API client (v4)
 *
 * Replaces the Anthropic SDK across the pipeline. All three LLM stages
 * (triage, editor, verifier) call generate() below. Uses the Gemini API
 * free tier: no per-token billing, rate-limited by requests per minute
 * and requests per day instead.
 *
 * Free-tier notes:
 *   - Prompts and responses on the free tier may be used by Google to
 *     improve their products. Everything this pipeline sends is public
 *     RSS content and mm!ke's editorial prompts, so that is acceptable.
 *   - Rate limits are low (roughly 10-15 requests/minute). The retry
 *     logic below backs off generously on 429/503.
 *
 * Model selection (override via env, verify names in Google AI Studio):
 *   GEMINI_MODEL_TRIAGE   default gemini-flash-lite-latest
 *   GEMINI_MODEL_EDITOR   default gemini-flash-latest
 *   GEMINI_MODEL_VERIFIER default gemini-flash-latest
 *
 * Expects: GEMINI_API_KEY
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const MAX_RETRIES = 4;
const DEFAULT_RETRY_AFTER = 45; // seconds; free tier RPM windows are short

export const MODELS = {
  triage: process.env.GEMINI_MODEL_TRIAGE || 'gemini-flash-lite-latest',
  editor: process.env.GEMINI_MODEL_EDITOR || 'gemini-flash-latest',
  verifier: process.env.GEMINI_MODEL_VERIFIER || 'gemini-flash-latest'
};

function parseRetryAfter(res, body) {
  const header = res.headers.get('retry-after');
  if (header) {
    const secs = parseInt(header, 10);
    if (!Number.isNaN(secs)) return secs;
  }
  // Gemini 429 bodies sometimes carry a RetryInfo detail like "30s"
  const m = typeof body === 'string' ? body.match(/"retryDelay"\s*:\s*"(\d+)s"/) : null;
  if (m) return parseInt(m[1], 10);
  return DEFAULT_RETRY_AFTER;
}

/**
 * Single-turn generation against the Gemini API.
 *
 * @param {object} opts
 * @param {string} opts.model       Gemini model name
 * @param {string} opts.system      System instruction (plain text)
 * @param {string} opts.user        User message (plain text)
 * @param {number} opts.maxTokens   Output token ceiling
 * @param {boolean} opts.useSearch  Attach the google_search grounding tool
 * @param {string} opts.label       Log label
 * @returns {{ text: string, usage: object }}
 */
export async function generate({ model, system, user, maxTokens = 4096, useSearch = false, label = 'llm' }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  const body = {
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 0.7
    }
  };

  if (system) {
    body.system_instruction = { parts: [{ text: system }] };
  }

  if (useSearch) {
    body.tools = [{ google_search: {} }];
  }

  const url = `${API_BASE}/${model}:generateContent`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const text = parts.map(p => p.text || '').join('');
      const u = data.usageMetadata || {};
      const usage = {
        input_tokens: u.promptTokenCount ?? null,
        output_tokens: u.candidatesTokenCount ?? null,
        total_tokens: u.totalTokenCount ?? null
      };
      if (!text) {
        const finish = data.candidates?.[0]?.finishReason || 'unknown';
        throw new Error(`[${label}] Empty response from ${model} (finishReason: ${finish})`);
      }
      return { text, usage };
    }

    const errBody = await res.text();

    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const wait = Math.min(parseRetryAfter(res, errBody) + 5, 300);
      console.log(`[${label}] ${res.status} from Gemini. Attempt ${attempt}/${MAX_RETRIES}. Waiting ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }

    throw new Error(`[${label}] Gemini API error ${res.status}: ${errBody.slice(0, 500)}`);
  }
}

export default { generate, MODELS };
