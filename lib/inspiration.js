'use strict';

const crypto = require('crypto');
const net = require('net');

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/images/search';
const PINTEREST_ENDPOINT = 'https://api.pinterest.com/v5/search/partner/pins';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ACTIVE_SEARCHES = 4;
const cache = new Map();
let activeSearches = 0;

class InspirationError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.name = 'InspirationError';
    this.statusCode = statusCode;
  }
}

function providerStatus() {
  const hasBraveKey = Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim());
  const hasPinterestToken = Boolean(process.env.PINTEREST_ACCESS_TOKEN?.trim());
  return {
    web: hasBraveKey,
    pinterest_api: hasPinterestToken,
    pinterest_via_web: hasBraveKey,
    any: hasBraveKey || hasPinterestToken
  };
}

function normalizeQuery(query, style) {
  const cleanQuery = query.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleanQuery) throw new InspirationError('La recherche doit contenir un sujet ou une idée.', 400);
  if (cleanQuery.length > 300) throw new InspirationError('La recherche est limitée à 300 caractères.', 400);

  const cleanStyle = typeof style === 'string'
    ? style.replace(/[_-]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80)
    : '';
  return { query: cleanQuery, style: cleanStyle };
}

function pinterestSearchUrl(query, style) {
  const terms = [query, style].filter(Boolean).join(' ');
  return `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(terms)}`;
}

function safeHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (parsed.protocol !== 'https:' || !hostname || parsed.username || parsed.password || net.isIP(hostname) ||
        hostname === 'localhost' || hostname.endsWith('.localhost') ||
        hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.test')) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function mapBraveResult(item, index, source) {
  const thumbnailUrl = safeHttpsUrl(
    item?.thumbnail?.src || item?.thumbnail_url ||
    (typeof item?.thumbnail === 'string' ? item.thumbnail : null) || item?.properties?.placeholder
  );
  const metaUrl = item?.meta_url?.scheme && (item?.meta_url?.netloc || item?.meta_url?.hostname)
    ? `${item.meta_url.scheme}://${item.meta_url.netloc || item.meta_url.hostname}${item.meta_url.path || ''}`
    : null;
  const sourceUrl = safeHttpsUrl(item?.source_url || item?.page_url || item?.url || metaUrl);
  const imageUrl = safeHttpsUrl(item?.properties?.url);
  if (!thumbnailUrl || !sourceUrl) return null;

  return {
    id: `brave-${index}`,
    title: String(item?.title || item?.description || 'Image d’inspiration').slice(0, 240),
    description: String(item?.description || '').slice(0, 500),
    source_url: sourceUrl,
    thumbnail_url: thumbnailUrl,
    image_url: imageUrl,
    source_name: String(item?.source || item?.meta_url?.hostname || new URL(sourceUrl).hostname).slice(0, 120),
    width: Number.isFinite(item?.properties?.width) ? item.properties.width : null,
    height: Number.isFinite(item?.properties?.height) ? item.properties.height : null,
    confidence: ['low', 'medium', 'high'].includes(item?.confidence) ? item.confidence : null,
    provider: source === 'pinterest' ? 'Brave · Pinterest indexé' : 'Brave Image Search'
  };
}

function findPinterestImages(media) {
  const images = media?.images || media?.image || media;
  const candidates = [];
  let visited = 0;
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 4 || visited++ >= 1000 || candidates.length >= 100) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    if (typeof value.url === 'string') {
      candidates.push({
        url: value.url,
        width: Number.isFinite(value.width) ? value.width : 0,
        height: Number.isFinite(value.height) ? value.height : 0
      });
      return;
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(images);
  return candidates.sort((a, b) => (b.width * b.height) - (a.width * a.height));
}

function mapPinterestPin(pin, index) {
  const image = findPinterestImages(pin?.media)[0];
  const thumbnailUrl = safeHttpsUrl(image?.url);
  const pinId = typeof pin?.id === 'string' && pin.id.length <= 128 ? pin.id : null;
  const linkedUrl = safeHttpsUrl(pin?.link);
  const linkedHost = linkedUrl ? new URL(linkedUrl).hostname : '';
  const sourceUrl = pinId
    ? `https://www.pinterest.com/pin/${encodeURIComponent(pinId)}/`
    : linkedHost === 'pinterest.com' || linkedHost.endsWith('.pinterest.com') ? linkedUrl : null;
  if (!thumbnailUrl || !sourceUrl) return null;

  return {
    id: pinId || `pinterest-${index}`,
    title: String(pin?.title || pin?.description || pin?.alt_text || 'Pin Pinterest').replace(/[\r\n\t]+/g, ' ').slice(0, 240),
    description: String(pin?.description || pin?.alt_text || '').replace(/[\r\n\t]+/g, ' ').slice(0, 500),
    source_url: sourceUrl,
    thumbnail_url: thumbnailUrl,
    image_url: thumbnailUrl,
    source_name: 'Pinterest',
    width: image?.width || null,
    height: image?.height || null,
    provider: 'Pinterest API'
  };
}

async function readJsonLimited(response, providerName) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new InspirationError(`${providerName} a renvoyé une réponse trop volumineuse.`, 502);
  }
  if (!response.body) throw new InspirationError(`${providerName} a renvoyé une réponse vide.`, 502);

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new InspirationError(`${providerName} a renvoyé une réponse trop volumineuse.`, 502);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof InspirationError) throw error;
    throw new InspirationError(`${providerName} a renvoyé une réponse illisible.`, 502);
  }

  try {
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8'));
  } catch {
    throw new InspirationError(`${providerName} a renvoyé une réponse illisible.`, 502);
  }
}

async function requestJson(url, options, providerName) {
  let response;
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(12000) });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new InspirationError(`${providerName} ne répond pas dans le délai prévu. Réessaie dans un instant.`, 504);
    }
    throw new InspirationError(`Connexion à ${providerName} impossible. Vérifie ta connexion Internet.`, 502);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const statusCode = response.status === 429 ? 429 : 502;
    const detail = response.status === 401 || response.status === 403
      ? 'la clé, les permissions ou l’accès au service ne sont pas valides'
      : response.status === 429
        ? 'la limite de requêtes du service est atteinte'
        : `le service a répondu ${response.status}`;
    throw new InspirationError(`${providerName} : ${detail}.`, statusCode);
  }

  return readJsonLimited(response, providerName);
}

async function searchWithBrave(query, style, source, limit) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) {
    throw new InspirationError(
      'La recherche d’images nécessite BRAVE_SEARCH_API_KEY dans le fichier .env. ' +
      'Crée une clé dans le tableau de bord Brave Search API. Le lien de recherche Pinterest direct reste disponible dans l’interface.',
      503
    );
  }

  const suffix = ['visual', 'inspiration', source === 'pinterest' ? 'site:pinterest.com' : '']
    .filter(Boolean);
  const maxCoreWords = 50 - suffix.length;
  const core = [query, style].filter(Boolean).join(' ').split(/\s+/).slice(0, maxCoreWords).join(' ');
  const terms = `${core} ${suffix.join(' ')}`.trim().slice(0, 400);
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set('q', terms);
  url.searchParams.set('count', String(Math.min(Math.max(limit, 1), 24)));
  url.searchParams.set('safesearch', 'strict');
  url.searchParams.set('country', 'ALL');
  url.searchParams.set('search_lang', process.env.BRAVE_SEARCH_LANG?.trim() || 'fr');

  const data = await requestJson(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey
    }
  }, 'Brave Image Search');
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.slice(0, Math.min(limit * 5, 100))
    .map((item, index) => mapBraveResult(item, index, source)).filter(Boolean).slice(0, limit);
}

async function searchWithPinterest(query, style, limit) {
  const token = process.env.PINTEREST_ACCESS_TOKEN?.trim();
  if (!token) return null;

  const url = new URL(PINTEREST_ENDPOINT);
  url.searchParams.set('term', [query, style].filter(Boolean).join(' '));
  url.searchParams.set('country_code', process.env.PINTEREST_COUNTRY_CODE?.trim() || 'NG');
  url.searchParams.set('locale', process.env.PINTEREST_LOCALE?.trim() || 'fr-FR');
  url.searchParams.set('limit', String(Math.min(limit, 10)));

  const data = await requestJson(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`
    }
  }, 'Pinterest');
  const pins = Array.isArray(data?.items) ? data.items : Array.isArray(data?.pins) ? data.pins : [];
  return pins.slice(0, Math.min(limit * 5, 50)).map(mapPinterestPin).filter(Boolean).slice(0, limit);
}

async function searchImageInspiration(options) {
  if (activeSearches >= MAX_ACTIVE_SEARCHES) {
    throw new InspirationError('La capacité de recherche est temporairement pleine. Réessaie dans un instant.', 503);
  }
  activeSearches++;
  try {
    return await searchImageInspirationInternal(options);
  } finally {
    activeSearches--;
  }
}

async function searchImageInspirationInternal({ query, style = '', source = 'web', limit = 12 }) {
  if (!['web', 'pinterest'].includes(source)) {
    throw new InspirationError('La source doit être « web » ou « pinterest ».', 400);
  }
  const normalized = normalizeQuery(query, style);
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 12, 1), source === 'pinterest' ? 10 : 24);
  const cacheKey = crypto.createHash('sha256')
    .update(JSON.stringify([normalized.query, normalized.style, source, safeLimit]))
    .digest('hex');
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.value, cached: true };
  }
  if (cached) cache.delete(cacheKey);

  let results;
  let provider;
  if (source === 'pinterest' && process.env.PINTEREST_ACCESS_TOKEN?.trim()) {
    try {
      results = await searchWithPinterest(normalized.query, normalized.style, safeLimit);
      provider = 'Pinterest API';
    } catch (error) {
      if (!process.env.BRAVE_SEARCH_API_KEY?.trim()) throw error;
      results = await searchWithBrave(normalized.query, normalized.style, 'pinterest', safeLimit);
      provider = 'Brave Image Search · filtre Pinterest';
    }
  } else {
    results = await searchWithBrave(normalized.query, normalized.style, source, safeLimit);
    provider = source === 'pinterest' ? 'Brave Image Search · filtre Pinterest' : 'Brave Image Search';
  }

  const value = {
    query: normalized.query,
    style: normalized.style,
    source,
    provider,
    results,
    pinterest_search_url: pinterestSearchUrl(normalized.query, normalized.style),
    cached: false
  };
  cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  return value;
}

module.exports = { searchImageInspiration, providerStatus, InspirationError };
