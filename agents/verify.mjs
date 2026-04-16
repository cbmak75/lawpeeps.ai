/**
 * mm!ke Verification Agent for lawpeeps.ai
 *
 * Given a list of identified stories, actively searches the web and fetches
 * primary sources to cross-reference claims before articles are drafted.
 *
 * This is the step that turns mm!ke from a passive digest reader into an
 * active journalist. If a story mentions a company, we check the company's
 * own site. If a claim comes from a single source, we search for independent
 * confirmation. If a tip comes in, we go looking for evidence.
 *
 * Requires: BRAVE_SEARCH_API_KEY environment variable (optional but recommended)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ─── Web Search ───────────────────────────────────────────────────

async function braveSearch(query, count = 5) {
  if (!BRAVE_SEARCH_API_KEY) {
    console.log(`  [search] No BRAVE_SEARCH_API_KEY, skipping search for: "${query}"`);
    return [];
  }

  try {
    const params = new URLSearchParams({
      q: query,
      count: String(count),
      text_decorations: 'false',
      search_lang: 'en',
    });

    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': BRAVE_SEARCH_API_KEY,
      },
    });

    if (!response.ok) {
      console.warn(`  [search] Brave API ${response.status}: ${await response.text()}`);
      return [];
    }

    const data = await response.json();
    const results = (data.web?.results || []).map(r => ({
      title: r.title,
      url: r.url,
      description: r.description || '',
      age: r.age || '',
    }));

    console.log(`  [search] "${query}" → ${results.length} results`);
    return results;
  } catch (err) {
    console.warn(`  [search] Failed: ${err.message}`);
    return [];
  }
}

// ─── URL Fetching ─────────────────────────────────────────────────

async function fetchPageText(url, maxChars = 3000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'lawpeeps.ai/1.0 (editorial verification)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);

    if (!response.ok) {
      return { url, error: `HTTP ${response.status}`, text: '' };
    }

    const html = await response.text();

    // Extract text content, stripping HTML
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxChars);

    console.log(`  [fetch] ${url} → ${text.length} chars`);
    return { url, text, error: null };
  } catch (err) {
    console.log(`  [fetch] ${url} → failed: ${err.message}`);
    return { url, error: err.message, text: '' };
  }
}

// ─── Claude for Search Query Generation ───────────────────────────

async function generateSearchQueries(story, digestItems) {
  if (!ANTHROPIC_API_KEY) {
    // Fallback: generate basic queries without Claude
    return generateBasicQueries(story, digestItems);
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `You are a verification researcher for a legal AI news publication. Given this story lead, generate search queries and URLs to check for cross-referencing.

STORY: ${story.title}
PITCH: ${story.pitch}
SOURCE ITEMS:
${digestItems.map(d => `- ${d.title}: ${d.description || '(no description)'} [${d.link || 'no link'}]`).join('\n')}

Generate:
1. 3-5 web search queries that would find independent confirmation or additional detail about this story
2. Specific URLs to check directly (company websites, blog pages, LinkedIn company pages, press pages, regulatory registers, Companies House, etc.)

Respond in JSON:
{
  "searchQueries": ["query 1", "query 2", ...],
  "directUrls": ["https://...", ...],
  "keyClaimsToVerify": ["claim 1 that needs checking", ...]
}`,
        }],
      }),
    });

    if (!response.ok) {
      console.warn(`  [queries] Claude API error: ${response.status}`);
      return generateBasicQueries(story, digestItems);
    }

    const data = await response.json();
    const text = data.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    console.warn(`  [queries] Failed to generate queries: ${err.message}`);
  }

  return generateBasicQueries(story, digestItems);
}

function generateBasicQueries(story, digestItems) {
  const queries = [];

  // Basic search from the title
  queries.push(story.title);

  // Extract company/product names and search for them
  const words = story.title.split(/\s+/);
  const capitalised = words.filter(w => /^[A-Z][a-z]/.test(w) && w.length > 3);
  if (capitalised.length > 0) {
    queries.push(`${capitalised.join(' ')} legal AI 2026`);
    queries.push(`${capitalised.join(' ')} announcement`);
  }

  // Direct URLs from digest items
  const directUrls = digestItems
    .filter(d => d.link)
    .map(d => d.link);

  return {
    searchQueries: queries,
    directUrls,
    keyClaimsToVerify: [`Verify the core claims in: ${story.title}`],
  };
}

// ─── Main Verification Pipeline ───────────────────────────────────

export async function verifyStories(stories, digest) {
  console.log(`\nVerification agent: checking ${stories.length} story/stories...\n`);

  const verificationResults = [];

  for (const story of stories) {
    console.log(`\n--- Verifying: "${story.title}" ---`);

    // Find the digest items for this story
    const relevantItems = digest.items.filter(item =>
      story.sourceItems.some(s =>
        item.title.toLowerCase().includes(s.toLowerCase().slice(0, 30))
      )
    );

    // Step 1: Generate search queries and URLs to check
    const queries = await generateSearchQueries(story, relevantItems);
    console.log(`  Generated ${queries.searchQueries.length} search queries, ${queries.directUrls.length} direct URLs`);

    // Step 2: Run web searches
    const searchResults = [];
    for (const query of queries.searchQueries.slice(0, 5)) {
      const results = await braveSearch(query, 5);
      searchResults.push(...results);

      // Rate limit: small delay between searches
      await new Promise(r => setTimeout(r, 300));
    }

    // Deduplicate search results by URL
    const seenUrls = new Set();
    const uniqueSearchResults = searchResults.filter(r => {
      if (seenUrls.has(r.url)) return false;
      seenUrls.add(r.url);
      return true;
    });

    // Step 3: Fetch primary source pages
    const pagesToFetch = [
      ...queries.directUrls.slice(0, 5),
      ...uniqueSearchResults.slice(0, 5).map(r => r.url),
    ];

    // Deduplicate
    const uniquePages = [...new Set(pagesToFetch)].slice(0, 8);

    const fetchedPages = [];
    for (const url of uniquePages) {
      const page = await fetchPageText(url);
      if (page.text.length > 50) {
        fetchedPages.push(page);
      }
    }

    // Step 4: Compile verification dossier
    const dossier = {
      story: story.title,
      searchResultCount: uniqueSearchResults.length,
      searchResults: uniqueSearchResults.slice(0, 10).map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.description.slice(0, 200),
      })),
      fetchedPages: fetchedPages.map(p => ({
        url: p.url,
        excerpt: p.text.slice(0, 2000),
      })),
      keyClaimsToVerify: queries.keyClaimsToVerify,
      verificationSummary: summariseVerification(story, uniqueSearchResults, fetchedPages),
    };

    verificationResults.push(dossier);

    console.log(`  Verification complete: ${uniqueSearchResults.length} search results, ${fetchedPages.length} pages fetched`);
  }

  return verificationResults;
}

function summariseVerification(story, searchResults, fetchedPages) {
  const lines = [];

  if (searchResults.length === 0 && fetchedPages.length === 0) {
    lines.push('NO INDEPENDENT VERIFICATION FOUND. Could not find any web results or fetch any source pages for this story. The article must clearly state this limitation.');
    return lines.join(' ');
  }

  if (searchResults.length > 0) {
    lines.push(`Found ${searchResults.length} web result(s) related to this story.`);

    // Check for multiple independent sources
    const domains = new Set(searchResults.map(r => {
      try { return new URL(r.url).hostname; } catch { return ''; }
    }).filter(Boolean));
    lines.push(`Results span ${domains.size} distinct domain(s): ${[...domains].slice(0, 5).join(', ')}.`);
  }

  if (fetchedPages.length > 0) {
    lines.push(`Successfully fetched ${fetchedPages.length} primary source page(s).`);
  }

  return lines.join(' ');
}

// Allow running standalone for testing
if (process.argv[1] && process.argv[1].includes('verify.mjs')) {
  console.log('Verification agent: standalone mode not yet supported. Use via editor.mjs.');
}
