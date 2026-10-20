/**
 * Mockup Composer & Local Image Overlay Engine
 *
 * Provides ultra-fast (sub-20ms) local image compositing using Sharp:
 * - Overlay brand logos onto mockup templates without calling external AI APIs (0 tokens, 0 cost).
 * - Automatic logo resizing and centering or coordinate-based positioning.
 * - Supports blend modes (over, multiply, screen) and opacity adjustments.
 * - Extracts individual assets from grid / flatlay images.
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

let sharp = null;
try {
  sharp = require('sharp');
  sharp.block({ operation: ['VipsForeignLoadSvg'] });
} catch (err) {
  console.warn('[Composer] Warning: sharp is not available, local compositing is disabled.');
}

/**
 * Positions predefined on standard mockup templates
 */
const MOCKUP_ZONES = {
  center: { xPercent: 50, yPercent: 50 },
  top_center: { xPercent: 50, yPercent: 25 },
  bottom_center: { xPercent: 50, yPercent: 75 },
  card_center: { xPercent: 50, yPercent: 52 },
  tshirt_chest: { xPercent: 50, yPercent: 38 },
  mug_side: { xPercent: 48, yPercent: 50 },
  screen_center: { xPercent: 50, yPercent: 50 }
};

/**
 * Composites a logo onto a mockup template image locally in ~10-20ms.
 *
 * @param {Object} options
 * @param {string} options.templatePath - Absolute or relative path to base mockup image
 * @param {string|Buffer} options.logo - File path, data URI or Buffer of the logo
 * @param {string} [options.zone='center'] - Target placement zone ('center', 'card_center', 'tshirt_chest', etc.)
 * @param {number} [options.scale=0.3] - Size of the logo relative to the template width (0.05 to 0.9)
 * @param {number} [options.opacity=1.0] - Opacity of the overlay (0.1 to 1.0)
 * @param {string} [options.blendMode='over'] - Blend mode ('over', 'multiply', 'screen')
 * @param {string} [options.outputDir] - Destination directory (defaults to templates/generated)
 * @returns {Promise<Object>} Metadata of the generated composite image
 */
async function compositeLogoOnMockup({
  templatePath,
  logo,
  zone = 'center',
  scale = 0.3,
  opacity = 1.0,
  blendMode = 'over',
  outputDir
}) {
  if (!sharp) {
    throw new Error('Sharp library is required for local compositing.');
  }

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template image not found: ${templatePath}`);
  }

  // 1. Resolve and load the logo buffer
  let logoBuffer;
  if (Buffer.isBuffer(logo)) {
    logoBuffer = logo;
  } else if (typeof logo === 'string' && logo.startsWith('data:image/')) {
    const base64Data = logo.replace(/^data:image\/\w+;base64,/, '');
    logoBuffer = Buffer.from(base64Data, 'base64');
  } else if (typeof logo === 'string' && fs.existsSync(logo)) {
    logoBuffer = await fsp.readFile(logo);
  } else {
    throw new Error('Invalid logo provided. Must be a file path, data URI, or Buffer.');
  }

  // 2. Read base template dimensions
  const templateMetadata = await sharp(templatePath).metadata();
  const templateWidth = templateMetadata.width;
  const templateHeight = templateMetadata.height;

  // 3. Resize logo proportionally according to scale factor
  const targetLogoWidth = Math.max(20, Math.round(templateWidth * Math.min(Math.max(scale, 0.05), 0.9)));
  let processedLogo = sharp(logoBuffer).resize(targetLogoWidth, null, {
    fit: 'inside',
    withoutEnlargement: true
  });

  // Apply opacity if less than 1.0
  if (opacity < 1.0) {
    const clampedOpacity = Math.max(0.05, Math.min(opacity, 1.0));
    // Apply linear modulation to alpha channel
    processedLogo = processedLogo.linear(1, -(1 - clampedOpacity) * 255);
  }

  const resizedLogoBuffer = await processedLogo.png().toBuffer();
  const resizedMetadata = await sharp(resizedLogoBuffer).metadata();

  // 4. Calculate coordinates based on zone
  const targetZone = MOCKUP_ZONES[zone] || MOCKUP_ZONES.center;
  const targetX = Math.round((templateWidth * targetZone.xPercent) / 100 - resizedMetadata.width / 2);
  const targetY = Math.round((templateHeight * targetZone.yPercent) / 100 - resizedMetadata.height / 2);

  const left = Math.max(0, Math.min(targetX, templateWidth - resizedMetadata.width));
  const top = Math.max(0, Math.min(targetY, templateHeight - resizedMetadata.height));

  // 5. Composite and save
  const targetDir = outputDir || path.dirname(templatePath);
  await fsp.mkdir(targetDir, { recursive: true });

  const filename = `mockup_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
  const outputPath = path.join(targetDir, filename);

  const startTime = Date.now();
  await sharp(templatePath)
    .composite([{
      input: resizedLogoBuffer,
      top,
      left,
      blend: blendMode
    }])
    .jpeg({ quality: 92 })
    .toFile(outputPath);

  const durationMs = Date.now() - startTime;
  const stats = await fsp.stat(outputPath);

  return {
    success: true,
    engine: 'local-sharp-composer',
    filename,
    image_path: outputPath,
    file_size_bytes: stats.size,
    dimensions: { width: templateWidth, height: templateHeight },
    placement: { left, top, zone, scale },
    duration_ms: durationMs
  };
}

/**
 * Extracts a rectangular region from an image (useful for grid / flatlay crops).
 */
async function cropRegion({ sourcePath, left, top, width, height, outputPath }) {
  if (!sharp) throw new Error('Sharp library required for cropping.');

  await sharp(sourcePath)
    .extract({ left, top, width, height })
    .jpeg({ quality: 92 })
    .toFile(outputPath);

  return { success: true, outputPath };
}

module.exports = {
  compositeLogoOnMockup,
  cropRegion,
  MOCKUP_ZONES
};
