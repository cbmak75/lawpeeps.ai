/**
 * og-image.mjs -- OG Image Generator
 *
 * Generates branded Open Graph images (1200x630) for articles.
 * Uses the lawpeeps.ai pink brand colour with the article title
 * overlaid. No external dependencies beyond Node.js built-ins
 * and the canvas package (installed in CI).
 *
 * Usage:
 *   import { generateOgImage } from './og-image.mjs';
 *   const path = await generateOgImage('My Article Title', 'my-article-slug');
 *
 * The generated image is saved to public/images/og/ and the
 * returned path is relative to public (for use in frontmatter).
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OG_DIR = join(__dirname, '..', 'public', 'images', 'og');
const LOGO_PATH = join(__dirname, '..', 'public', 'images', 'logo-white.png');

// Brand colours
const PINK = '#FF69B4';
const BLACK = '#1A1A1A';

/**
 * Generate an OG image for an article using SVG-to-PNG conversion.
 * Falls back gracefully if canvas/sharp aren't available in CI.
 *
 * @param {string} title - Article title
 * @param {string} slug - Article slug (used for filename)
 * @param {string} [category] - Optional category label
 * @returns {string|null} Path relative to public root, or null if generation failed
 */
async function generateOgImage(title, slug, category = '') {
  if (!existsSync(OG_DIR)) {
    mkdirSync(OG_DIR, { recursive: true });
  }

  const outputPath = join(OG_DIR, `${slug}.png`);
  const publicPath = `/images/og/${slug}.png`;

  // Skip if already generated
  if (existsSync(outputPath)) {
    console.log(`[og-image] Already exists: ${publicPath}`);
    return publicPath;
  }

  // Try using sharp (lightweight, commonly available in CI)
  try {
    const sharp = (await import('sharp')).default;

    // Word-wrap the title to fit the image
    const maxCharsPerLine = 28;
    const words = title.split(' ');
    const lines = [];
    let currentLine = '';

    for (const word of words) {
      if ((currentLine + ' ' + word).trim().length > maxCharsPerLine && currentLine) {
        lines.push(currentLine.trim());
        currentLine = word;
      } else {
        currentLine = (currentLine + ' ' + word).trim();
      }
    }
    if (currentLine) lines.push(currentLine.trim());

    // Limit to 4 lines max
    const displayLines = lines.slice(0, 4);
    if (lines.length > 4) {
      displayLines[3] = displayLines[3].slice(0, -3) + '...';
    }

    // Build SVG with title text
    const lineHeight = 58;
    const startY = 315 - ((displayLines.length - 1) * lineHeight) / 2;

    const titleElements = displayLines.map((line, i) => {
      const escaped = line
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      return `<text x="600" y="${startY + i * lineHeight}" text-anchor="middle" fill="white" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="48">${escaped}</text>`;
    }).join('\n    ');

    const categoryElement = category
      ? `<text x="600" y="${startY - 50}" text-anchor="middle" fill="white" font-family="Arial, Helvetica, sans-serif" font-size="22" opacity="0.8">${category.replace(/&/g, '&amp;').toUpperCase()}</text>`
      : '';

    const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="${PINK}"/>
  <rect x="40" y="40" width="1120" height="550" rx="0" fill="none" stroke="white" stroke-width="3" opacity="0.3"/>
  ${categoryElement}
  ${titleElements}
  <text x="600" y="${startY + displayLines.length * lineHeight + 30}" text-anchor="middle" fill="white" font-family="Arial, Helvetica, sans-serif" font-size="24" opacity="0.7">lawpeeps.ai</text>
</svg>`;

    await sharp(Buffer.from(svg))
      .png()
      .toFile(outputPath);

    console.log(`[og-image] Generated: ${publicPath}`);
    return publicPath;

  } catch (err) {
    console.warn(`[og-image] sharp not available, skipping generation: ${err.message}`);

    // Fall back to the default OG image
    return null;
  }
}

export { generateOgImage };

// Standalone mode: generate OG image for a given title and slug
if (process.argv[1] && process.argv[1].endsWith('og-image.mjs') && process.argv[2]) {
  const title = process.argv[2];
  const slug = process.argv[3] || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
  const category = process.argv[4] || '';

  generateOgImage(title, slug, category)
    .then(path => {
      if (path) {
        console.log(`[og-image] Done: ${path}`);
      } else {
        console.log('[og-image] Generation failed, will use default.');
      }
    })
    .catch(err => {
      console.error('[og-image] Error:', err);
      process.exit(1);
    });
}
