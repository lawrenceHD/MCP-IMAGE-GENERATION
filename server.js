/**
 * Antigravity Image Generation MCP & Web API Server
 *
 * Supports two operational modes:
 * 1. MCP Stdio Mode (flag: --stdio) for MCP Hosts (Antigravity IDE, Cursor, Claude Desktop)
 * 2. HTTP / REST API Mode (default) with Web UI for your web project
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const net = require('net');
const { pathToFileURL } = require('url');

// Attempt native .env loading (Node 20+)
if (typeof process.loadEnvFile === 'function') {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // Ignore if .env is missing or invalid
    }
  }
}

const isStdioMode = process.argv.includes('--stdio');

// In Stdio mode, ensure stdout is ONLY used for MCP JSON-RPC messages.
// Redirect console.log and console.info to stderr to prevent stream corruption.
if (isStdioMode) {
  console.log = (...args) => {
    process.stderr.write(`[LOG] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}\n`);
  };
  console.info = (...args) => {
    process.stderr.write(`[INFO] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}\n`);
  };
}

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const {
  generateImage,
  getAgyExecutablePath,
  getQueueStats,
  killAllChildren,
  DEFAULT_STORAGE_DIR,
  IMAGEN_MODEL,
  GEMINI_IMAGE_MODEL,
  GEMINI_FREE_MODEL,
  imageCache
} = require('./lib/generator');
const {
  STYLE_PRESETS,
  ASPECT_RATIO_PRESETS
} = require('./lib/promptHelper');
const {
  searchImageInspiration,
  providerStatus: getInspirationProviderStatus,
  InspirationError
} = require('./lib/inspiration');
const {
  compositeLogoOnMockup,
  MOCKUP_ZONES
} = require('./lib/composer');

let sharp = null;
try {
  sharp = require('sharp');
  sharp.block({ operation: ['VipsForeignLoadSvg'] });
} catch {
  // Optional dependency: without it, thumbnails fall back to the full image when small enough
}

const VERSION = '2.2.0';
const parsedPort = Number(process.env.PORT || '3333');
if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const PORT = parsedPort;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const API_TOKEN = (process.env.API_TOKEN || '').trim();
const ALLOW_REMOTE_ACCESS = process.env.ALLOW_REMOTE_ACCESS === 'true';
const AGY_SKIP_PERMISSIONS = process.env.AGY_SKIP_PERMISSIONS === 'true';
const AGY_SANDBOX_DISABLED = process.env.AGY_SANDBOX === 'false';
const THUMBNAIL_SIZE = 512;
const MAX_INLINE_FULL_BYTES = 300 * 1024;

function isLoopbackHost(host) {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (net.isIP(normalized) === 4) return normalized.split('.')[0] === '127';
  return normalized.startsWith('::ffff:127.');
}

const IS_LOOPBACK_BIND = isLoopbackHost(HOST);

if (API_TOKEN && Buffer.byteLength(API_TOKEN) < 32) {
  throw new Error('API_TOKEN must contain at least 32 characters.');
}
let parsedPublicBase;
try { parsedPublicBase = new URL(PUBLIC_BASE_URL); } catch { parsedPublicBase = null; }
if (!parsedPublicBase || !['http:', 'https:'].includes(parsedPublicBase.protocol) ||
    parsedPublicBase.origin !== PUBLIC_BASE_URL || parsedPublicBase.username || parsedPublicBase.password) {
  throw new Error('PUBLIC_BASE_URL must be an exact HTTP or HTTPS origin without credentials, path, query or fragment.');
}
const REMOTE_HTTP_ACCESS = !IS_LOOPBACK_BIND || !isLoopbackHost(parsedPublicBase.hostname);
const AUTH_REQUIRED = Boolean(API_TOKEN) || REMOTE_HTTP_ACCESS;
if (!REMOTE_HTTP_ACCESS) {
  const publicPort = Number(parsedPublicBase.port || (parsedPublicBase.protocol === 'https:' ? 443 : 80));
  if (parsedPublicBase.protocol !== 'http:' || publicPort !== PORT) {
    throw new Error('A loopback server requires an HTTP PUBLIC_BASE_URL using the configured PORT.');
  }
}
if (!isStdioMode && REMOTE_HTTP_ACCESS) {
  const remoteHosts = (process.env.ALLOWED_HOSTS || '').split(',').map((value) => value.trim()).filter(Boolean);
  const remoteOrigins = (process.env.CORS_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean);
  const publicBase = parsedPublicBase;
  if (!ALLOW_REMOTE_ACCESS) throw new Error('Remote HTTP access is disabled. Set ALLOW_REMOTE_ACCESS=true only behind a trusted HTTPS reverse proxy.');
  if (Buffer.byteLength(API_TOKEN) < 32) throw new Error('Remote HTTP binding requires an API_TOKEN of at least 32 characters.');
  if (!remoteHosts.length) throw new Error('Remote HTTP access requires ALLOWED_HOSTS with the exact Host header values clients will use.');
  if (!remoteOrigins.length || remoteOrigins.includes('*')) throw new Error('Remote HTTP binding requires explicit CORS_ORIGIN values; wildcard origins are not allowed.');
  if (!publicBase || publicBase.protocol !== 'https:' || publicBase.origin !== PUBLIC_BASE_URL) throw new Error('Remote HTTP binding requires PUBLIC_BASE_URL to be an exact HTTPS origin.');
  if (publicBase && !remoteHosts.map((host) => host.toLowerCase()).includes(publicBase.host.toLowerCase())) throw new Error('PUBLIC_BASE_URL host must also appear in ALLOWED_HOSTS.');
  if (AGY_SKIP_PERMISSIONS || AGY_SANDBOX_DISABLED) throw new Error('Remote HTTP binding requires normal CLI permissions and the default sandbox.');
}

function requireApiToken(req, res, next) {
  if (!AUTH_REQUIRED) return next();
  const authorization = req.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const provided = Buffer.from(match ? match[1] : '');
  const expected = Buffer.from(API_TOKEN);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

function publicGenerationError(error) {
  const message = String(error?.message || '');
  const safePrefixes = [
    'Prompt ', 'Reference image', 'Unsupported data URI', 'Too many reference',
    'Image storage limit', 'Generated image', 'Image provider', 'Inline base64',
    'Google API billing required', 'Google API request failed', 'Google API unreachable',
    'Gemini free model returned', 'Gemini image API returned', 'Google Imagen API returned',
    'Antigravity image quota exhausted', 'Antigravity CLI exited', 'Antigravity CLI did not',
    'Image generation timed out', 'Failed to start the Antigravity CLI process', 'Server busy'
  ];
  return safePrefixes.some((prefix) => message.startsWith(prefix))
    ? message.slice(0, 400)
    : 'Image generation failed. Check the server logs for details.';
}

function generationErrorStatus(error) {
  if (Number.isInteger(error?.statusCode)) return error.statusCode;
  if (error?.status === 429) return 429;
  if (error?.status >= 400) return 502;
  const message = String(error?.message || '');
  if (/^(Prompt |Reference image|Unsupported data URI|Too many reference|Invalid image )/.test(message)) return 400;
  return 500;
}

function supportedImageHeader(header, extension) {
  const ext = extension.toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (ext === '.png') return header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === '.webp') return header.length >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

async function resolveGeneratedImageFile(storageDir, filename) {
  if (!/^img_\d+_[a-f0-9]{8,32}\.(?:jpg|png|webp)$/i.test(filename) || filename.includes('..')) return null;
  try {
    const storageRoot = await fsp.realpath(storageDir);
    const requestedPath = path.join(storageRoot, filename);
    const fileStat = await fsp.lstat(requestedPath);
    const imagePath = await fsp.realpath(requestedPath);
    const relative = path.relative(storageRoot, imagePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || relative === '..' ||
        relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || fileStat.size > 25 * 1024 * 1024) return null;
    const handle = await fsp.open(imagePath, 'r');
    const header = Buffer.alloc(12);
    let bytesRead;
    try { ({ bytesRead } = await handle.read(header, 0, header.length, 0)); }
    finally { await handle.close(); }
    if (!supportedImageHeader(header.subarray(0, bytesRead), path.extname(filename))) return null;
    return { imagePath, fileStat };
  } catch {
    return null;
  }
}

const STYLES = Object.keys(STYLE_PRESETS);
const ASPECT_RATIOS = Object.keys(ASPECT_RATIO_PRESETS);

function hasDirectKey() {
  return Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
}

function shutdown() {
  killAllChildren();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/**
 * Builds the image block returned to the MCP host. A 512px WebP thumbnail costs
 * a fraction of the tokens of the full-resolution image.
 */
async function buildImageContent(result, mode) {
  if (mode === 'none') return null;

  if (mode === 'thumbnail' && sharp) {
    const buffer = await sharp(result.image_path)
      .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 70 })
      .toBuffer();
    return { type: 'image', data: buffer.toString('base64'), mimeType: 'image/webp' };
  }

  if (mode === 'thumbnail' && result.file_size_bytes > MAX_INLINE_FULL_BYTES) {
    return null;
  }
  if (mode === 'full' && result.file_size_bytes > 8 * 1024 * 1024) return null;

  const data = (await fsp.readFile(result.image_path)).toString('base64');
  return { type: 'image', data, mimeType: result.mime_type };
}

// Initialize MCP Server definition
const mcp = new McpServer({
  name: 'antigravity-image-generator',
  version: VERSION
});

mcp.registerTool(
  'generate_image',
  {
    title: 'Generate image',
    description:
      'Generate an image from a text prompt (or edit/transform reference images) and save it to disk. ' +
      'Returns a small preview, the file path and a file:// link. Identical requests are served instantly from cache. ' +
      'Write the prompt with subject, setting, lighting and composition; style and aspect ratio keywords are added automatically.',
    inputSchema: {
      prompt: z.string().min(1).max(2000).describe('Image description: subject, scene, lighting, composition'),
      style: z.enum(STYLES).optional().default('default').describe('Visual style preset'),
      aspect_ratio: z.enum(ASPECT_RATIOS).optional().default('1:1'),
      reference_images: z.array(z.string()).max(3).optional().default([])
        .describe('Optional images to edit/transform: image_path of a previously generated image, or a data URI'),
      return_image: z.enum(['thumbnail', 'full', 'none']).optional().default('thumbnail')
        .describe('Image returned inline. "thumbnail" (512px) is enough to check the result and saves tokens'),
      force: z.boolean().optional().default(false).describe('Bypass the cache and regenerate')
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async ({ prompt, style, aspect_ratio, reference_images, return_image, force }, extra) => {
    // Periodic progress notifications keep MCP clients from timing out on slow CLI generations
    const progressToken = extra?._meta?.progressToken;
    let ticks = 0;
    const heartbeat = progressToken !== undefined
      ? setInterval(() => {
        ticks++;
        extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken, progress: ticks, message: `Generating image... (${ticks * 10}s)` }
        }).catch(() => {});
      }, 10000)
      : null;

    try {
      const result = await generateImage({
        prompt,
        style,
        aspectRatio: aspect_ratio,
        referenceImages: reference_images,
        force
      });

      const content = [];
      const image = await buildImageContent(result, return_image);
      if (image) content.push(image);

      content.push({
        type: 'resource_link',
        uri: pathToFileURL(result.image_path).href,
        name: result.filename,
        mimeType: result.mime_type
      });

      content.push({
        type: 'text',
        text: JSON.stringify({
          image_path: result.image_path,
          engine: result.engine,
          cached: result.cached || false,
          size_kb: Math.round(result.file_size_bytes / 1024)
        })
      });

      return { content };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Image generation failed: ${publicGenerationError(error)}` }]
      };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
);

mcp.registerTool(
  'search_image_inspiration',
  {
    title: 'Search image inspiration',
    description:
      'Search the web or Pinterest for visual references relevant to an image prompt and style. ' +
      'Returns linked thumbnails, source pages and a direct Pinterest search link. References are for inspiration; check usage rights before reusing an image.',
    inputSchema: {
      query: z.string().min(1).max(300).describe('Subject, scene, product or image idea to research'),
      style: z.enum(STYLES).optional().default('default').describe('Visual style to include in the search'),
      source: z.enum(['web', 'pinterest']).optional().default('web').describe('Search all indexed images or focus on Pinterest'),
      limit: z.number().int().min(1).max(24).optional().default(12).describe('Maximum number of references (Pinterest: up to 10)')
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async ({ query, style, source, limit }) => {
    try {
      const result = await searchImageInspiration({ query, style, source, limit });
      const lines = [
        `Recherche : ${result.query}${result.style ? ` · style ${result.style}` : ''}`,
        `Source : ${result.provider}${result.cached ? ' · cache' : ''}`,
        `Pinterest : ${result.pinterest_search_url}`,
        ''
      ];
      if (!result.results.length) lines.push('Aucun résultat avec vignette exploitable. Essaie une requête plus précise.');
      result.results.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.title}`, `   Source : ${item.source_name}`, `   Voir la référence : ${item.source_url}`);
        if (item.confidence) lines.push(`   Pertinence estimée par le moteur : ${item.confidence}`);
        if (item.thumbnail_url) lines.push(`   Vignette : ${item.thumbnail_url}`);
      });
      lines.push('', 'Les vignettes servent à explorer des pistes visuelles. Vérifie les droits avant toute réutilisation.');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Recherche d’inspiration impossible : ${error instanceof InspirationError ? error.message : 'erreur interne.'}` }]
      };
    }
  }
);

// MCP Tool: composite_mockup (Ultra-fast local logo composition on mockups via Sharp - 0 API tokens)
const ZONES_LIST = Object.keys(MOCKUP_ZONES);
mcp.registerTool(
  'composite_mockup',
  {
    title: 'Composite Logo on Mockup',
    description:
      'Ultra-fast local mockup generation (sub-50ms, 0 API tokens, 0 cost). ' +
      'Composites a brand logo onto an existing blank mockup template in generated_images. ' +
      'Supports auto-scaling, placement zones, opacity, and blend modes.',
    inputSchema: {
      template_filename: z.string().describe('Filename of the base mockup image inside generated_images (e.g. img_...jpg)'),
      logo: z.string().describe('Brand logo as a data URI (data:image/png;base64,...) or file path'),
      zone: z.enum(ZONES_LIST).optional().default('center').describe('Placement zone on the mockup'),
      scale: z.number().min(0.05).max(0.9).optional().default(0.28).describe('Logo width relative to the mockup (0.05 to 0.9)'),
      opacity: z.number().min(0.1).max(1.0).optional().default(1.0).describe('Logo opacity (0.1 to 1.0)'),
      blend_mode: z.enum(['over', 'multiply', 'screen']).optional().default('over').describe('Blend mode for compositing')
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ template_filename, logo, zone, scale, opacity, blend_mode }) => {
    try {
      const templatePath = path.join(DEFAULT_STORAGE_DIR, path.basename(template_filename));
      if (!fs.existsSync(templatePath)) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Template introuvable : ${template_filename}` }]
        };
      }

      const result = await compositeLogoOnMockup({
        templatePath,
        logo,
        zone,
        scale,
        opacity,
        blendMode: blend_mode,
        outputDir: DEFAULT_STORAGE_DIR
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              engine: result.engine,
              filename: result.filename,
              image_path: result.image_path,
              duration_ms: result.duration_ms,
              dimensions: result.dimensions
            })
          }
        ]
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Erreur lors de la composition locale : ${err.message}` }]
      };
    }
  }
);

// MCP Resource: image://recent (Catalog of recent generated images)
mcp.registerResource(
  'recent_images',
  'image://recent',
  { description: 'Recently generated images (path, prompt, style)', mimeType: 'application/json' },
  async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify(imageCache.getRecent(15).map(({ image_path, prompt, style, aspect_ratio, created_at }) =>
        ({ image_path, prompt, style, aspect_ratio, created_at })))
    }]
  })
);

// MCP Resource: stats://server (cache and queue diagnostics, no tool definition overhead)
mcp.registerResource(
  'server_stats',
  'stats://server',
  { description: 'Cache and queue statistics', mimeType: 'application/json' },
  async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify({ cache: imageCache.getStats(), queues: getQueueStats() })
    }]
  })
);

// ============================================================
// Execution Mode Handling
// ============================================================

if (isStdioMode) {
  // Connect via MCP Standard IO transport
  const transport = new StdioServerTransport();
  mcp.connect(transport).then(() => {
    process.stderr.write('Antigravity MCP Image Server connected via stdio transport.\n');
  }).catch((err) => {
    process.stderr.write(`MCP Stdio connection failed: ${err.message}\n`);
    process.exit(1);
  });
  process.stdin.on('close', shutdown);
} else {
  // Start Express HTTP Server for Web Project Integration
  const express = require('express');
  const cors = require('cors');

  const app = express();
  app.disable('x-powered-by');

  const remoteHosts = (process.env.ALLOWED_HOSTS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  for (const host of remoteHosts) {
    const match = host.match(/^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i);
    const portText = match?.[1];
    const port = portText ? Number(portText) : 0;
    let parsedHost;
    try { parsedHost = new URL(`http://${host}`); } catch { parsedHost = null; }
    if (!match || host.includes('*') || (portText && (port < 1 || port > 65535 || String(port) !== portText)) ||
        !parsedHost || !parsedHost.hostname || parsedHost.username || parsedHost.password) {
      throw new Error('ALLOWED_HOSTS values must be exact host or host:port entries.');
    }
  }
  const allowedHosts = new Set(!REMOTE_HTTP_ACCESS
    ? [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`, ...remoteHosts]
    : remoteHosts);
  const allowedOrigins = (process.env.CORS_ORIGIN || (!REMOTE_HTTP_ACCESS ? `http://localhost:${PORT},http://127.0.0.1:${PORT}` : ''))
    .split(',').map((origin) => origin.trim()).filter(Boolean);
  if (allowedOrigins.includes('*')) throw new Error('CORS_ORIGIN wildcard is not supported; use explicit origins.');
  if (allowedOrigins.some((origin) => {
    try {
      const parsed = new URL(origin);
      return !['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password;
    } catch { return true; }
  })) {
    throw new Error('CORS_ORIGIN values must be exact HTTP or HTTPS origins.');
  }
  if (REMOTE_HTTP_ACCESS && allowedOrigins.some((origin) => new URL(origin).protocol !== 'https:')) {
    throw new Error('Remote CORS_ORIGIN values must use HTTPS.');
  }

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data: https:; connect-src 'self' https:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    next();
  });

  app.use((req, res, next) => {
    const hostHeader = (req.headers.host || '').toLowerCase();
    if (!allowedHosts.has(hostHeader)) return res.status(403).json({ error: 'Host not allowed.' });
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) return res.status(403).json({ error: 'Origin not allowed.' });
    next();
  });
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)) }));

  const rateLimitMap = new Map();
  const windowMs = 60000;
  const maxRateLimitKeys = 5000;
  function rateLimit(maxRequests, label) {
    return (req, res, next) => {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const key = `${label}:${ip}`;
      let record = rateLimitMap.get(key);
      if (!record || now >= record.resetAt) record = { count: 0, resetAt: now + windowMs };
      record.count++;
      if (!rateLimitMap.has(key) && rateLimitMap.size >= maxRateLimitKeys) {
        return res.status(503).json({ error: 'Request limiter is busy. Please retry shortly.' });
      }
      rateLimitMap.set(key, record);
      if (record.count > maxRequests) return res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
      next();
    };
  }
  function limitConcurrentRequests(maxActive, label) {
    let active = 0;
    return (req, res, next) => {
      if (active >= maxActive) return res.status(503).json({ error: `${label} capacity is full. Please retry shortly.` });
      active++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
      };
      res.once('finish', release);
      res.once('close', release);
      req.once('aborted', release);
      next();
    };
  }
  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of rateLimitMap) if (now >= record.resetAt) rateLimitMap.delete(key);
  }, windowMs).unref();

  // Count failed-token traffic too, before it reaches protected handlers.
  app.use('/api', rateLimit(240, 'api-auth'), requireApiToken);
  app.use('/images', rateLimit(240, 'image-auth'), requireApiToken);
  app.use('/health', rateLimit(240, 'health-auth'), requireApiToken);
  app.use('/api', rateLimit(120, 'api'));
  app.use('/images', rateLimit(120, 'images'));
  app.use('/images', limitConcurrentRequests(4, 'Image delivery'));
  app.use('/api/generate', rateLimit(10, 'generate'), limitConcurrentRequests(4, 'Generation'), express.json({ limit: '35mb' }));
  app.use('/api/inspiration/search', rateLimit(12, 'inspiration'), limitConcurrentRequests(4, 'Inspiration search'));
  app.use(express.json({ limit: '1mb' }));

  const outputImagesDir = DEFAULT_STORAGE_DIR;
  const imageUrl = (filename) => `${PUBLIC_BASE_URL}/images/${encodeURIComponent(filename)}`;
  const thumbnailUrl = (filename) => `${imageUrl(filename)}/thumbnail`;
  // Serve the web playground. Generated images use the authenticated route below.
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/images/:filename/thumbnail', async (req, res) => {
    const filename = req.params.filename;
    const image = await resolveGeneratedImageFile(outputImagesDir, filename);
    if (!image) return res.status(404).json({ error: 'Image not found.' });
    if (!sharp) return res.status(503).json({ error: 'Image thumbnail service is unavailable.' });
    try {
      const buffer = await sharp(image.imagePath, { limitInputPixels: 25000000 })
        .resize(96, 96, { fit: 'cover', withoutEnlargement: true })
        .webp({ quality: 65 })
        .toBuffer();
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.type('image/webp').send(buffer);
    } catch {
      res.status(422).json({ error: 'Image thumbnail could not be created.' });
    }
  });

  app.get('/images/:filename', async (req, res) => {
    const image = await resolveGeneratedImageFile(outputImagesDir, req.params.filename);
    if (!image) return res.status(404).json({ error: 'Image not found.' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.sendFile(image.imagePath, { dotfiles: 'deny' }, (error) => {
      if (error && !res.headersSent) res.status(error.statusCode || 404).json({ error: 'Image not found.' });
    });
  });

  app.get('/health', requireApiToken, (req, res) => {
    const hasKey = hasDirectKey();
    res.json({
      status: 'ok',
      service: 'antigravity-mcp-image-server',
      version: VERSION,
      engines: {
        free_api: hasKey ? `Google Free API (${GEMINI_FREE_MODEL})` : 'unavailable (set GEMINI_API_KEY)',
        paid_api: hasKey ? `Google Paid API (${IMAGEN_MODEL} / ${GEMINI_IMAGE_MODEL})` : 'unavailable (set GEMINI_API_KEY)',
        cli: 'Antigravity CLI Subagent (always available)'
      },
      active_engine: hasKey ? `Google Free API (${GEMINI_FREE_MODEL})` : 'Antigravity CLI Subagent',
      direct_api_configured: hasKey,
      auth_required: AUTH_REQUIRED,
      queues: getQueueStats(),
      cache: imageCache.getStats(),
      timestamp: new Date().toISOString()
    });
  });

  // Get available styles and aspect ratios
  app.get('/api/styles', (req, res) => {
    res.json({
      styles: STYLE_PRESETS,
      aspect_ratios: ASPECT_RATIO_PRESETS
    });
  });

  app.get('/api/inspiration/status', (req, res) => {
    res.json({ providers: getInspirationProviderStatus() });
  });

  app.post('/api/inspiration/search', async (req, res) => {
    const { query, style = 'default', source = 'web', limit = 12 } = req.body || {};
    if (typeof query !== 'string') {
      return res.status(400).json({ error: 'Le champ « query » doit être une chaîne de caractères.' });
    }
    if (!STYLES.includes(style)) {
      return res.status(400).json({ error: `Style invalide. Choisis parmi : ${STYLES.join(', ')}.` });
    }
    if (!['web', 'pinterest'].includes(source)) {
      return res.status(400).json({ error: 'La source doit être « web » ou « pinterest ».' });
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 24) {
      return res.status(400).json({ error: 'La limite doit être un nombre entier entre 1 et 24.' });
    }

    try {
      const result = await searchImageInspiration({ query, style, source, limit });
      res.json({ success: true, ...result });
    } catch (error) {
      const statusCode = error instanceof InspirationError ? error.statusCode : 502;
      res.status(statusCode).json({ error: error instanceof InspirationError ? error.message : 'La recherche a échoué.' });
    }
  });

  // Get image library / gallery
  app.get('/api/library', async (req, res) => {
    try {
      const directory = await fsp.opendir(outputImagesDir);
      const files = [];
      let scanned = 0;
      for await (const entry of directory) {
        if (++scanned > 10000) break;
        if (!entry.isFile() || !/^img_\d+_[a-f0-9]{8,32}\.(?:jpg|png|webp)$/i.test(entry.name)) continue;
        const filePath = path.join(outputImagesDir, entry.name);
        const stats = await fsp.lstat(filePath).catch(() => null);
        if (!stats?.isFile() || stats.isSymbolicLink() || stats.size > 25 * 1024 * 1024) continue;
        files.push({ filename: entry.name, url: imageUrl(entry.name), created_at: stats.mtime });
      }
      files.sort((a, b) => b.created_at - a.created_at);

      res.json({ success: true, images: files.slice(0, 80).map((file) => ({ ...file, thumbnail_url: thumbnailUrl(file.filename) })) });
    } catch {
      res.status(500).json({ success: false, error: 'Image library is unavailable.' });
    }
  });

  // Cache stats endpoint
  app.get('/api/cache', (req, res) => {
    const recent = imageCache.getRecent(10).map(({ filename, style, aspect_ratio, file_size_bytes, created_at }) => ({
      filename,
      style,
      aspect_ratio,
      file_size_bytes,
      created_at,
      image_url: imageUrl(filename)
    }));
    res.json({
      stats: imageCache.getStats(),
      recent
    });
  });

  // Clear cache endpoint
  app.post('/api/cache/clear', (req, res) => {
    imageCache.clear();
    res.json({ success: true, message: 'Cache successfully cleared.' });
  });

  // Queue status endpoint
  app.get('/api/queue', (req, res) => {
    res.json(getQueueStats());
  });

  // REST API: Generate Image
  app.post('/api/generate', async (req, res) => {
    const {
      prompt,
      style = 'default',
      aspect_ratio = '1:1',
      include_base64 = false,
      force = false,
      reference_images = []
    } = req.body || {};

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "prompt" parameter in request body.' });
    }
    if (prompt.length > 2000) {
      return res.status(400).json({ error: 'Prompt must not exceed 2000 characters.' });
    }
    if (!STYLES.includes(style)) {
      return res.status(400).json({ error: `Invalid "style". Allowed: ${STYLES.join(', ')}` });
    }
    if (!ASPECT_RATIOS.includes(aspect_ratio)) {
      return res.status(400).json({ error: `Invalid "aspect_ratio". Allowed: ${ASPECT_RATIOS.join(', ')}` });
    }
    if (typeof include_base64 !== 'boolean' || typeof force !== 'boolean') {
      return res.status(400).json({ error: 'include_base64 and force must be boolean values.' });
    }
    if (!Array.isArray(reference_images) || reference_images.length > 3 || reference_images.some((value) => typeof value !== 'string')) {
      return res.status(400).json({ error: 'reference_images must be an array of at most 3 image strings.' });
    }

    try {
      console.log(`[API] Image task received (Style: ${style}, Ratio: ${aspect_ratio}).`);

      const result = await generateImage({
        prompt,
        style,
        aspectRatio: aspect_ratio,
        outputDir: outputImagesDir,
        includeBase64: Boolean(include_base64),
        force: Boolean(force),
        referenceImages: reference_images
      });

      res.json({
        success: true,
        cached: result.cached || false,
        engine: result.engine,
        image_url: imageUrl(result.filename),
        filename: result.filename,
        file_size_bytes: result.file_size_bytes,
        mime_type: result.mime_type,
        prompt: result.prompt,
        enhanced_prompt: result.enhanced_prompt,
        base64: result.base64 || null
      });
    } catch (err) {
      console.error('[API] Generation request failed:', err.status ? `provider status ${err.status}` : 'internal error');
      res.status(generationErrorStatus(err)).json({
        success: false,
        error: publicGenerationError(err)
      });
    }
  });

  // Get available mockup placement zones
  app.get('/api/mockup/zones', (req, res) => {
    res.json({
      success: true,
      zones: MOCKUP_ZONES
    });
  });

  // REST API: Composite logo onto mockup template (ultra-fast, local Sharp engine, 0 tokens)
  app.post('/api/mockup/composite', async (req, res) => {
    const {
      template_filename,
      logo,
      zone = 'center',
      scale = 0.28,
      opacity = 1.0,
      blend_mode = 'over'
    } = req.body || {};

    if (!template_filename || typeof template_filename !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "template_filename" parameter.' });
    }
    if (!logo || typeof logo !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "logo" parameter (must be data URI or valid file path).' });
    }
    const cleanTemplateName = path.basename(template_filename);
    const templatePath = path.join(outputImagesDir, cleanTemplateName);
    if (!fs.existsSync(templatePath)) {
      return res.status(404).json({ error: `Template image not found: ${cleanTemplateName}` });
    }
    if (!Object.keys(MOCKUP_ZONES).includes(zone)) {
      return res.status(400).json({ error: `Invalid zone. Allowed: ${Object.keys(MOCKUP_ZONES).join(', ')}` });
    }

    try {
      const result = await compositeLogoOnMockup({
        templatePath,
        logo,
        zone,
        scale: Number(scale) || 0.28,
        opacity: Number(opacity) || 1.0,
        blendMode: blend_mode,
        outputDir: outputImagesDir
      });

      res.json({
        success: true,
        engine: result.engine,
        image_url: imageUrl(result.filename),
        thumbnail_url: thumbnailUrl(result.filename),
        filename: result.filename,
        duration_ms: result.duration_ms,
        dimensions: result.dimensions,
        placement: result.placement
      });
    } catch (err) {
      console.error('[API] Mockup composite error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error?.type === 'entity.too.large' ? 413
      : error?.type === 'entity.parse.failed' ? 400
        : Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status
          : 500;
    if (status === 413) return res.status(status).json({ error: 'Request body is too large.' });
    if (status === 400) return res.status(status).json({ error: 'Request body is invalid.' });
    console.error('[HTTP] Request failed:', status);
    return res.status(status).json({ error: 'Internal server error.' });
  });

  app.listen(PORT, HOST, () => {
    console.log('='.repeat(65));
    console.log(`🚀 ANTIGRAVITY IMAGE GENERATION MCP & WEB SERVER v${VERSION} RUNNING`);
    console.log('='.repeat(65));
    console.log(`📡 Web API & Playground : ${PUBLIC_BASE_URL} (bound to ${HOST})`);
    console.log(`🖼️  Images Endpoint     : ${PUBLIC_BASE_URL}/images/<filename>`);
    console.log(`⚙️  Health & Diagnostics : http://localhost:${PORT}/health`);
    console.log(`⚡ Active Engine        : ${hasDirectKey() ? `Google API (${IMAGEN_MODEL})` : 'Antigravity CLI Subagent (Free Mode)'}`);
    console.log(`🔐 API Token            : ${API_TOKEN ? 'required' : 'disabled (set API_TOKEN in .env)'}`);
    console.log(`💾 Cache System         : SHA-256 Enabled (${DEFAULT_STORAGE_DIR})`);
    console.log(`🔌 MCP Mode Command     : node server.js --stdio`);
    console.log(`🧩 Agy CLI              : ${getAgyExecutablePath()}`);
    console.log('='.repeat(65));
  });
}
