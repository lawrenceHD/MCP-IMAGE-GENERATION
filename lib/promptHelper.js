/**
 * Prompt Helper for Antigravity Image Generator
 * Enriches user prompts with modern aesthetic descriptors and sanitizes input
 * to prevent prompt injection and token bloat.
 */

const STYLE_PRESETS = {
  // ── General purpose ──────────────────────────────────────────────────────
  photorealistic: "professional DSLR photography, 50mm lens, natural studio lighting, authentic textures and subtle depth of field",
  cinematic: "cinematic film still, anamorphic widescreen framing, dramatic atmospheric lighting, 35mm film grain, color-graded",
  anime: "modern Japanese animation visual style, clean line art, vibrant atmospheric lighting, expressive concept art",
  digital_art: "contemporary digital concept illustration, rich color harmony, painterly lighting, polished composition",
  "3d_render": "octane 3D render, ray-traced global illumination, volumetric ambient lighting, realistic materials",
  minimalist: "minimalist visual composition, balanced negative space, clean geometric balance, elegant understated color palette",
  default: "balanced composition, natural lighting, high aesthetic fidelity, rich visual depth",

  // ── Brand & identity (charte graphique, mockups) ─────────────────────────
  brand_mockup: "professional product mockup, photorealistic materials, soft studio shadows, brand-consistent color palette, clean white or neutral background, commercial photography quality",
  logo_brand: "clean vector-style brand identity, sharp edges, scalable composition, professional color harmony, typographic precision, modern corporate aesthetic",
  charte_graphique: "comprehensive brand system visualization, consistent visual identity, color palette swatches, typography hierarchy, logo usage examples, professional design agency presentation style",
  ui_mockup: "high-fidelity UI/UX mockup on device frame, realistic screen reflection, depth of field, modern flat design, precise grid alignment, professional app screenshot presentation",
  packaging: "realistic 3D product packaging mockup, photographic lighting, accurate material textures (matte/glossy/foil), studio photography, e-commerce ready presentation",
  advertising: "commercial advertising visual, bold composition, brand-forward design, aspirational lifestyle photography, high contrast, print-ready quality, campaign hero image"
};

const ASPECT_RATIO_PRESETS = {
  "1:1":  "square 1:1 framing",
  "16:9": "landscape 16:9 widescreen format",
  "9:16": "vertical 9:16 mobile portrait format",
  "4:3":  "standard 4:3 format",
  "3:4":  "classic 3:4 portrait format",
  "4:5":  "vertical 4:5 social media portrait format",
  "3:2":  "classic 3:2 landscape photography format"
};

/**
 * Sanitize prompt against prompt-injections, shell escapes and token flooding
 * @param {string} rawPrompt
 * @param {number} maxLength
 * @returns {string}
 */
function sanitizePrompt(rawPrompt, maxLength = 800) {
  if (!rawPrompt || typeof rawPrompt !== 'string') {
    throw new Error('Prompt parameter is required and must be a string.');
  }

  // Remove potential dangerous terminal escape sequences and control characters
  let clean = rawPrompt.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Collapse multiple whitespace/newlines
  clean = clean.replace(/\s+/g, ' ').trim();

  // Guard against common agent jailbreak prefixes that attempt tool abuse
  const jailbreakPatterns = [
    /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
    /execute\s+(system|shell|bash|powershell|cmd)/i,
    /run\s+(command|script|tool)/i,
    /format\s+drive|delete\s+file|rm\s+-rf/i
  ];

  for (const pattern of jailbreakPatterns) {
    if (pattern.test(clean)) {
      throw new Error('Prompt rejected: Contains disallowed system control or jailbreak keywords.');
    }
  }

  if (clean.length === 0) {
    throw new Error('Prompt cannot be empty.');
  }

  if (clean.length > maxLength) {
    clean = clean.substring(0, maxLength);
  }

  return clean;
}

/**
 * Builds an optimized prompt from user input
 * @param {string} prompt - Raw user prompt
 * @param {string} [style='default'] - Visual style
 * @param {string} [aspectRatio='1:1'] - Aspect ratio
 * @returns {string} Fully engineered prompt
 */
function buildEnhancedPrompt(prompt, style = 'default', aspectRatio = '1:1') {
  const cleanPrompt = sanitizePrompt(prompt);
  const styleKeywords = STYLE_PRESETS[style] || STYLE_PRESETS.default;
  const ratioKeywords = ASPECT_RATIO_PRESETS[aspectRatio] || ASPECT_RATIO_PRESETS["1:1"];

  return `${cleanPrompt}. Aesthetic specifications: ${styleKeywords}, ${ratioKeywords}.`;
}

module.exports = {
  STYLE_PRESETS,
  ASPECT_RATIO_PRESETS,
  sanitizePrompt,
  buildEnhancedPrompt
};
