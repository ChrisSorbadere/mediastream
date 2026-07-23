/**
 * MediaStream Proxy — v2
 *  • ?url=...        → proxy RSS + audio/vidéo podcasts (comme avant)
 *  • /b2/Dossier/Fichier.mp3 → sert un fichier privé Backblaze B2 (signé S3 V4)
 *
 * Variables d'environnement à définir dans Cloudflare (Settings → Variables) :
 *   B2_KEY_ID       = 0031b4dae2e97300000000003   (Text)
 *   B2_APP_KEY      = <ton applicationKey>         (Secret / Encrypt)
 *   B2_BUCKET       = mediastream-cs               (Text)
 *   B2_ENDPOINT     = s3.eu-central-003.backblazeb2.com   (Text)
 *   B2_REGION       = eu-central-003               (Text)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // ─── Route B2 : /b2/<chemin du fichier dans le bucket> ───
    if (url.pathname.startsWith('/b2list/')) {
      return listB2(request, env, url);
    }
    if (url.pathname.startsWith('/b2/')) {
      return serveB2(request, env, url);
    }

    // ─── Route proxy podcasts : ?url=... ───
    const target = url.searchParams.get('url');
    if (!target) {
      return new Response('Paramètre ?url= manquant', { status: 400, headers: corsHeaders() });
    }
    return proxyPodcast(request, target);
  },
};

// ═══════════════════════════════════════════
// BACKBLAZE B2 (API S3, signature AWS V4)
// ═══════════════════════════════════════════
async function serveB2(request, env, url) {
  try {
    // Chemin du fichier dans le bucket (après /b2/), ex: "Dormir/3H Ondes Delta .mp3"
    const objectKey = decodeURIComponent(url.pathname.slice(4)); // enlève "/b2/"
    if (!objectKey) return new Response('Chemin B2 manquant', { status: 400, headers: corsHeaders() });

    const host = env.B2_ENDPOINT;                 // s3.eu-central-003.backblazeb2.com
    const region = env.B2_REGION;                 // eu-central-003
    const bucket = env.B2_BUCKET;                 // mediastream-cs
    // Chaque segment est encodé en mode strict AWS (' ( ) ! * inclus), on garde les "/"
    const encodedKey = objectKey.split('/').map(awsUriEncode).join('/');
    const canonicalUri = `/${bucket}/${encodedKey}`;
    const endpoint = `https://${host}${canonicalUri}`;

    const range = request.headers.get('Range');
    const signed = await signS3Request({
      method: 'GET', host, region, canonicalUri,
      keyId: env.B2_KEY_ID, appKey: env.B2_APP_KEY, range,
    });

    const upstream = await fetch(endpoint, { method: 'GET', headers: signed });

    const respHeaders = new Headers();
    ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Last-Modified', 'ETag']
      .forEach(h => { const v = upstream.headers.get(h); if (v) respHeaders.set(h, v); });
    respHeaders.set('Accept-Ranges', 'bytes');
    respHeaders.set('Cache-Control', 'no-store'); // pas de mise en cache intermédiaire (fiabilise le streaming)
    Object.entries(corsHeaders()).forEach(([k, v]) => respHeaders.set(k, v));

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  } catch (err) {
    return new Response('Erreur B2: ' + err.message, { status: 502, headers: corsHeaders() });
  }
}

// Liste les fichiers d'un "dossier" (préfixe) du bucket B2 → renvoie du JSON
async function listB2(request, env, url) {
  try {
    const prefix = decodeURIComponent(url.pathname.slice(8)); // enlève "/b2list/"
    const host = env.B2_ENDPOINT, region = env.B2_REGION, bucket = env.B2_BUCKET;
    const canonicalUri = `/${bucket}`;
    // Paramètres S3 list-objects-v2. La chaîne canonique doit être triée par clé
    // et chaque valeur encodée. Ici : list-type=2, puis prefix=...
    const canonicalQuery = `list-type=2&prefix=${encodeURIComponent(prefix).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
    const signed = await signS3Request({
      method: 'GET', host, region, canonicalUri,
      keyId: env.B2_KEY_ID, appKey: env.B2_APP_KEY, query: canonicalQuery,
    });
    const endpoint = `https://${host}${canonicalUri}?${canonicalQuery}`;
    const upstream = await fetch(endpoint, { method: 'GET', headers: signed });
    const xml = await upstream.text();
    if (!upstream.ok) {
      return new Response('Erreur B2 list: ' + xml.slice(0, 300), { status: upstream.status, headers: corsHeaders() });
    }
    // Extrait les <Key> du XML (fichiers)
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => decodeXml(m[1]));
    const files = keys
      .filter(k => !k.endsWith('/')) // ignore les pseudo-dossiers
      .filter(k => /\.(mp3|m4a|opus|ogg|aac|wav|flac|mp4|m4v|webm)$/i.test(k))
      .map(k => ({ key: k, name: k.split('/').pop() }));
    return new Response(JSON.stringify({ files }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  } catch (err) {
    return new Response('Erreur B2 list: ' + err.message, { status: 502, headers: corsHeaders() });
  }
}
function decodeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
// Encodage strict conforme à AWS Signature V4 (encode aussi ! ' ( ) *)
function awsUriEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Signature AWS Signature V4 pour une requête GET S3
async function signS3Request({ method, host, region, canonicalUri, keyId, appKey, range, query }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');     // 20260101T120000Z
  const dateStamp = amzDate.slice(0, 8);                              // 20260101
  const service = 's3';
  const payloadHash = 'UNSIGNED-PAYLOAD';

  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (range) headers['range'] = range;

  // Canonical headers (triés par nom)
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map(k => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  const canonicalRequest = [
    method, canonicalUri, (query || ''), canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest),
  ].join('\n');

  // Clé de signature dérivée
  const kDate = await hmac('AWS4' + appKey, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  const authorization = `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const out = new Headers();
  out.set('Authorization', authorization);
  out.set('x-amz-content-sha256', payloadHash);
  out.set('x-amz-date', amzDate);
  if (range) out.set('Range', range);
  return out;
}

// ── utilitaires crypto (Web Crypto API, dispo dans les Workers) ──
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return toHex(buf);
}
async function hmac(key, str) {
  const keyBuf = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey('raw', keyBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(str));
}
function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ═══════════════════════════════════════════
// PROXY PODCASTS (inchangé)
// ═══════════════════════════════════════════
async function proxyPodcast(request, target) {
  try {
    const fwdHeaders = new Headers();
    const range = request.headers.get('Range');
    if (range) fwdHeaders.set('Range', range);
    fwdHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    fwdHeaders.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,audio/*;q=0.8,video/*;q=0.8,*/*;q=0.7');
    fwdHeaders.set('Accept-Language', 'fr-FR,fr;q=0.9,en;q=0.8');
    // PAS de compression : elle fausse la taille annoncée et empêche le navigateur
    // de connaître la durée et de se déplacer dans le fichier (barre de progression bloquée).
    fwdHeaders.set('Accept-Encoding', 'identity');
    fwdHeaders.set('Sec-Ch-Ua', '"Chromium";v="126", "Google Chrome";v="126", "Not.A/Brand";v="24"');
    fwdHeaders.set('Sec-Ch-Ua-Mobile', '?0');
    fwdHeaders.set('Sec-Ch-Ua-Platform', '"Windows"');

    const upstream = await fetch(target, { method: request.method, headers: fwdHeaders, redirect: 'follow' });
    const respHeaders = new Headers(upstream.headers);
    Object.entries(corsHeaders()).forEach(([k, v]) => respHeaders.set(k, v));
    // On n'annonce le support du déplacement que si la source le gère réellement
    const srcRanges = upstream.headers.get('Accept-Ranges');
    if (upstream.status === 206 || (srcRanges && srcRanges !== 'none')) {
      respHeaders.set('Accept-Ranges', 'bytes');
    } else {
      respHeaders.delete('Accept-Ranges');
    }
    // La compression masquerait la vraie taille du fichier
    respHeaders.delete('Content-Encoding');
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: respHeaders });
  } catch (err) {
    return new Response('Erreur proxy: ' + err.message, { status: 502, headers: corsHeaders() });
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  };
}
