/**
 * tip-received.mjs -- Netlify Function
 *
 * Fires when a tip line form is submitted. Dispatches a GitHub
 * Actions workflow to investigate the tip immediately.
 *
 * Netlify triggers this automatically via the submission-created
 * event when the form name matches "tipline".
 *
 * Requires environment variables:
 *   GITHUB_DISPATCH_TOKEN  -- GitHub PAT with repo scope
 *   GITHUB_REPO            -- e.g. "cbmak75/lawpeeps.ai"
 */

export default async (req) => {
  try {
    const payload = await req.json();

    // Only act on tipline form submissions
    if (payload.form_name !== 'tipline') {
      return new Response('Not a tipline submission, ignoring.', { status: 200 });
    }

    const tipData = payload.data || {};
    const token = process.env.GITHUB_DISPATCH_TOKEN;
    const repo = process.env.GITHUB_REPO || 'cbmak75/lawpeeps.ai';

    if (!token) {
      console.error('[tip-received] GITHUB_DISPATCH_TOKEN not set');
      return new Response('Missing dispatch token', { status: 500 });
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
            subject: tipData.subject || '',
            message: tipData.message || tipData.details || '',
            url: tipData.url || '',
            name: tipData.name || 'Anonymous',
            email: tipData.email || '',
            credit_preference: tipData.credit_preference || 'anonymous',
            submitted_at: payload.created_at || new Date().toISOString(),
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`[tip-received] GitHub dispatch failed: ${response.status} ${error}`);
      return new Response(`Dispatch failed: ${response.status}`, { status: 500 });
    }

    console.log(`[tip-received] Dispatched investigation for tip: ${tipData.subject || 'untitled'}`);
    return new Response('Tip dispatched for investigation.', { status: 200 });

  } catch (err) {
    console.error('[tip-received] Error:', err);
    return new Response('Internal error', { status: 500 });
  }
};

export const config = {
  path: '/.netlify/functions/tip-received',
};
