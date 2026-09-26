import http from 'node:http';
import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';

const METHODS = new Set(['begin', 'snapshot', 'finish', 'cancel', 'execute']);
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const MAX_BODY = 512_000;
const cleanText = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';
function pageUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin + url.pathname : ''; }
  catch { return ''; }
}

// A private transport for the explicitly paired browser tab. This does not expose
// a general browser, JavaScript evaluation, or an unauthenticated localhost API.
export function createBrowserTeachingBridge({token = randomBytes(32).toString('hex'), port = 0, onChange, requestTimeoutMs = 25_000, pollTimeoutMs = 20_000, leaseMs = 45_000} = {}) {
  if (typeof token !== 'string' || token.length < 24 || token.length > 256 || /\s/.test(token)) throw new Error('Browser pairing needs a strong token.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid browser bridge port.');
  let server = null, starting = null, actualPort = null, session = null, extensionOrigin = null, closed = false, leaseTimer = null;
  const jobs = new Map();
  const queue = [];
  let poll = null;
  const status = () => ({connected: !!session, ...(session ? {url: session.url, title: session.title, tabId: session.tabId, documentId: session.documentId, connectedAt: session.connectedAt} : {}), ...(actualPort ? {port: actualPort} : {})});
  const changed = () => { try { onChange?.(status()); } catch {} };
  function send(response, code, body) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
    response.end(JSON.stringify(body));
  }
  function releasePoll(body = {command: null}) {
    if (!poll) return;
    const current = poll; poll = null; clearTimeout(current.timer); send(current.response, 200, body);
  }
  function settle(job, error, result) {
    if (!jobs.delete(job.id)) return;
    clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.abort);
    const at = queue.indexOf(job.id); if (at >= 0) queue.splice(at, 1);
    error ? job.reject(error) : job.resolve(result);
  }
  function disconnect(reason = 'The browser tab disconnected.') {
    const previous = session; session = null;
    clearTimeout(leaseTimer); leaseTimer = null;
    releasePoll({command: null, disconnected: true});
    for (const job of [...jobs.values()]) settle(job, new Error(reason));
    queue.length = 0;
    if (previous) changed();
  }
  function touch() {
    clearTimeout(leaseTimer);
    leaseTimer = setTimeout(() => disconnect('The browser connection expired. Connect the tab again.'), leaseMs);
    leaseTimer.unref?.();
  }
  function deliver() {
    if (!poll || !session) return;
    let job;
    while (queue.length && !job) job = jobs.get(queue.shift());
    if (!job) return;
    job.delivered = true;
    releasePoll({command: {id: job.id, sessionId: session.id, method: job.method, payload: job.payload, expiresAt: job.expiresAt}});
  }
  function authorized(header) {
    if (typeof header !== 'string') return false;
    const supplied = Buffer.from(header), expected = Buffer.from(`Bearer ${token}`);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
  async function body(request) {
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw Object.assign(new Error('Use application/json.'), {status: 415});
    let bytes = 0; const chunks = [];
    for await (const chunk of request) { bytes += chunk.length; if (bytes > MAX_BODY) throw Object.assign(new Error('Request too large.'), {status: 413}); chunks.push(chunk); }
    let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON.'), {status: 400}); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Expected an object.'), {status: 400});
    return value;
  }
  async function handle(request, response) {
    const origin = request.headers.origin;
    if (request.headers.host !== `127.0.0.1:${actualPort}` || !EXTENSION_ORIGIN.test(origin || '') || (extensionOrigin && origin !== extensionOrigin)) return send(response, 403, {error: 'Only the paired Chrome extension may connect.'});
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      return send(response, 200, {});
    }
    if (!authorized(request.headers.authorization)) return send(response, 401, {error: 'Invalid pairing token.'});
    const url = new URL(request.url, `http://127.0.0.1:${actualPort}`);
    if (request.method === 'POST' && url.pathname === '/connect') {
      const input = await body(request), nextUrl = pageUrl(input.url);
      if (!nextUrl || !Number.isSafeInteger(input.tabId) || input.tabId < 0 || typeof input.documentId !== 'string' || !input.documentId || input.documentId.length > 200) return send(response, 400, {error: 'Connect one ordinary web tab.'});
      disconnect('A new browser tab was connected.');
      extensionOrigin = origin;
      session = {id: randomUUID(), url: nextUrl, title: cleanText(input.title, 200), tabId: input.tabId, documentId: input.documentId, connectedAt: Date.now()};
      touch(); changed(); return send(response, 200, {sessionId: session.id, leaseMs});
    }
    const input = request.method === 'POST' ? await body(request) : null;
    const sessionId = input?.sessionId || url.searchParams.get('sessionId');
    if (!session || sessionId !== session.id) return send(response, 409, {error: 'The browser session expired. Connect this tab again.'});
    touch();
    if (['GET', 'POST'].includes(request.method) && url.pathname === '/poll') {
      // One outstanding poll per paired document. Replacing a poll cannot replay a delivered job.
      releasePoll();
      poll = {response, timer: setTimeout(() => releasePoll(), pollTimeoutMs)};
      const mine = poll;
      response.on('close', () => { if (poll === mine) { clearTimeout(mine.timer); poll = null; } });
      deliver(); return;
    }
    if (request.method === 'POST' && url.pathname === '/reply') {
      const job = jobs.get(input.id);
      if (!job || !job.delivered || job.sessionId !== session.id) return send(response, 409, {error: 'This command is no longer active.'});
      if (typeof input.error === 'string' && input.error) settle(job, new Error(cleanText(input.error, 400)));
      else if (!input.result || typeof input.result !== 'object' || Array.isArray(input.result)) settle(job, new Error('The browser returned an invalid result.'));
      else {
        const resultUrl = input.result.url || input.result.after?.url;
        if (resultUrl && pageUrl(resultUrl) !== session.url) { disconnect('The connected page changed. Connect this tab again.'); return send(response, 409, {error: 'Page scope changed.'}); }
        settle(job, null, input.result);
      }
      return send(response, 200, {ok: true});
    }
    if (request.method === 'POST' && url.pathname === '/disconnect') { disconnect(cleanText(input.reason, 300) || 'The browser tab disconnected.'); return send(response, 200, {ok: true}); }
    return send(response, 404, {error: 'Unknown browser bridge endpoint.'});
  }
  function start() {
    if (closed) return Promise.reject(new Error('The browser bridge is closed.'));
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      server = http.createServer((request, response) => { handle(request, response).catch(error => send(response, error.status || 500, {error: error.status ? error.message : 'The browser request failed.'})); });
      server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1000;
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { actualPort = server.address().port; resolve({port: actualPort, token}); });
    });
    return starting;
  }
  function request(method, payload = {}, {signal} = {}) {
    if (!METHODS.has(method)) return Promise.reject(new Error('Unsupported browser teaching action.'));
    if (!session || closed) return Promise.reject(new Error('Connect this tab with the Summon browser extension first.'));
    if (signal?.aborted) return Promise.reject(new Error('The browser action was cancelled.'));
    if (method === 'cancel') {
      for (const job of [...jobs.values()]) if (!job.delivered && job.method === 'execute') settle(job, new Error('The queued browser action was cancelled.'));
    }
    if (jobs.size >= 16) return Promise.reject(new Error('Too many browser actions are waiting.'));
    let safePayload;
    try { const encoded = JSON.stringify(payload); if (encoded.length > 64_000) throw new Error(); safePayload = JSON.parse(encoded); }
    catch { return Promise.reject(new Error('Invalid browser action payload.')); }
    return new Promise((resolve, reject) => {
      const job = {id: randomUUID(), sessionId: session.id, method, payload: safePayload, signal, resolve, reject, delivered: false, expiresAt: Date.now() + requestTimeoutMs};
      // A cancelled delivered command invalidates the whole connection. The extension
      // loses its session on the next poll and disarms instead of consuming later work.
      job.abort = () => job.delivered ? disconnect('The browser action was cancelled. Connect this tab again.') : settle(job, new Error('The browser action was cancelled.'));
      job.timer = setTimeout(() => job.delivered ? disconnect('The browser action timed out. Connect this tab again.') : settle(job, new Error('The browser action timed out.')), requestTimeoutMs);
      signal?.addEventListener('abort', job.abort, {once: true});
      jobs.set(job.id, job); method === 'cancel' ? queue.unshift(job.id) : queue.push(job.id); deliver();
    });
  }
  async function close() {
    if (closed) return; closed = true; disconnect('Summon closed the browser connection.');
    if (!server) return;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
  }
  return {start, status, request, close};
}
