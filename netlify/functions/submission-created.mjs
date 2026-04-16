/**
 * submission-created.mjs -- Netlify Event-Triggered Function
 *
 * Netlify automatically calls this function whenever a form is
 * submitted. No webhook configuration needed -- the function name
 * "submission-created" is a Netlify convention.
 *
 * When a tipline form is submitted, this dispatches a GitHub
 * Actions workflow to investigate the tip immediately.
 *
 * Requires environment variables (set in Netlify UI):
 *   GITHUB_DISPATCH_TOKEN  -- GitHub PAT with repo scope
 *   GITHUB_REPO            -- e.g. "cbmak75/lawpeeps.ai"
 */

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body);

    // Netlify wraps submission data inside a "payload" property
    const payload = body.payload || body;

    // Only act on tipline form submissions
    if (payload.form_name !== 'tipline') {
      console.log(`[submission-created] Ignoring form: ${payload.form_name}`);
      return { statusCode: 200, body: 'Not a tipline submission.' };
    }

    const tipData = payload.data || {};
    const token = process.env.GITHUB_DISPATCH_TOKEN;
    const repo = process.env.GITHUB_REPO || 'cbmak75/lawpeeps.ai';

    if (!token) {
      console.error('[submission-created] GITHUB_DISPATCH_TOKEN not set');
      return { statusCode: 500, body: 'Missing dispatch token.' };
    }

    // Fire repository_dispatch to trigger the tip investigation workflow
    const response = await fetch(
      `https://api.github.com/repos/${repo}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          event_type: 'tip-received',
          client_payload: {
            tip_id: payload.id || `tip-${Date.now()}`,
            subject: tipData.content ? tipData.content.slice(0, 120) : '',
            message: tipData.content || '',
            url: tipData.links || '',
            name: tipData.name || 'Anonymous',
            email: tipData.email || '',
            credit_preference: tipData.credit === 'yes' ? 'credit' : 'anonymous',
            submitted_at: payload.created_at || new Date().toISOString(),
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`[submission-created] GitHub dispatch failed: ${response.status} ${error}`);
      return { statusCode: 500, body: `Dispatch failed: ${response.status}` };
    }

    console.log(`[submission-created] Dispatched tip investigation: ${tipData.subject || 'untitled'}`);
    return { statusCode: 200, body: 'Tip dispatched for investigation.' };

  } catch (err) {
    console.error('[submission-created] Error:', err);
    return { statusCode: 500, body: 'Internal error.' };
  }
};
