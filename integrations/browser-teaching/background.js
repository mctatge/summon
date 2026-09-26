'use strict';
let connection = null, pairing = null, lastError = '', epoch = 0, controller = null, polling = false;
const initialized = chrome.storage.session.get(['connection', 'pairing', 'lastError']).then(saved => {
  connection = saved.connection || null; pairing = saved.pairing || null; lastError = saved.lastError || '';
});
const safeUrl = raw => { try { const value = new URL(raw); return /^https?:$/.test(value.protocol) && !value.username && !value.password ? value.origin + value.pathname : ''; } catch { return ''; } };
async function badge(text) { await chrome.action.setBadgeText({text}); await chrome.action.setBadgeBackgroundColor({color: text === 'REC' ? '#9b3f28' : '#285c4d'}); }
async function api(path, body, config = pairing, abortSignal) {
  if (!config) throw new Error('Pair this extension with Summon first.');
  const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {method: body === undefined ? 'GET' : 'POST', headers: {Authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : {'Content-Type': 'application/json'})}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: abortSignal, cache: 'no-store', credentials: 'omit', redirect: 'error'});
  const value = await response.json(); if (!response.ok) throw new Error(value.error || `Summon returned ${response.status}.`); return value;
}
async function tabCommand(method, payload, current = connection) {
  if (!current) throw new Error('Connect this tab first.');
  const tab = await chrome.tabs.get(current.tabId);
  if (safeUrl(tab.url) !== current.url) throw new Error('The connected page changed. Connect this tab again.');
  if (['begin', 'execute'].includes(method) && !tab.active) throw new Error('Bring the connected tab to the front before teaching or acting.');
  const response = await chrome.tabs.sendMessage(current.tabId, {channel: 'summon-teaching', documentId: current.documentId, method, payload});
  if (!response || response.error) throw new Error(response?.error || 'The connected page is unavailable.');
  return response.result;
}
async function disconnect(reason = '', report = true) {
  const previous = connection, previousPairing = pairing;
  epoch++; controller?.abort(); controller = null; polling = false; connection = null; lastError = reason;
  await chrome.storage.session.set({connection: null, lastError}); await badge('');
  if (previous) {
    await Promise.allSettled([
      tabCommand('cancel', {}, previous),
      ...(report ? [api('/disconnect', {sessionId: previous.sessionId, reason}, previousPairing, AbortSignal.timeout(2500))] : []),
    ]);
  }
}
async function loop() {
  await initialized; if (polling || !connection) return;
  polling = true; const generation = epoch;
  try {
    while (connection && generation === epoch) {
      const current = connection;
      // Each completed long poll calls an extension API in less than Chrome's
      // 30-second idle window. A content heartbeat also resumes after sleep.
      await chrome.storage.session.get('connection');
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 24_000);
      let received;
      // Extension GETs can omit Origin; POST reliably carries it so the server
      // can keep enforcing its exact paired extension origin for every request.
      try { received = await api('/poll', {sessionId: current.sessionId}, pairing, controller.signal); }
      finally { clearTimeout(timeout); }
      if (generation !== epoch || connection !== current) break;
      if (received.disconnected) throw new Error('Summon disconnected this tab. Connect it again.');
      const job = received.command; if (!job) continue;
      if (job.sessionId !== current.sessionId || typeof job.id !== 'string' || !['begin', 'snapshot', 'finish', 'cancel', 'execute'].includes(job.method) || !Number.isFinite(job.expiresAt) || Date.now() > job.expiresAt) throw new Error('Summon sent an expired or invalid command.');
      let result, error;
      try { result = await tabCommand(job.method, job.payload); if (job.method === 'begin') await badge('REC'); else if (['finish', 'cancel'].includes(job.method)) await badge('ON'); }
      catch (failure) { error = failure.message; }
      if (generation !== epoch || connection !== current) break;
      await api('/reply', {sessionId: current.sessionId, id: job.id, ...(error ? {error} : {result})}, pairing, AbortSignal.timeout(5000));
    }
  } catch (error) {
    if (generation === epoch) await disconnect(error.name === 'AbortError' ? 'Summon stopped responding. Connect this tab again.' : error.message);
  } finally { if (generation === epoch) polling = false; }
}
async function connectTab(message) {
  if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535 || typeof message.token !== 'string' || message.token.length < 24 || message.token.length > 256 || /\s/.test(message.token)) throw new Error('Copy the port and pairing token from Summon.');
  const tab = await chrome.tabs.get(message.tabId);
  if (!tab.active || !safeUrl(tab.url)) throw new Error('Open an ordinary web page and connect its active tab.');
  await disconnect();
  pairing = {port: message.port, token: message.token};
  await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['content.js']});
  const hello = await chrome.tabs.sendMessage(tab.id, {channel: 'summon-teaching', method: 'hello'});
  if (!hello?.result || hello.error || hello.result.url !== safeUrl(tab.url)) throw new Error(hello?.error || 'Could not connect this page.');
  const details = {...hello.result, tabId: tab.id};
  const paired = await api('/connect', details, pairing, AbortSignal.timeout(5000));
  connection = {...details, sessionId: paired.sessionId}; lastError = '';
  await chrome.storage.session.set({connection, pairing, lastError}); await badge('ON'); void loop();
  return {connected: true, url: connection.url, title: connection.title};
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.channel === 'summon-teaching-heartbeat') {
    initialized.then(async () => {
      if (!connection || sender.tab?.id !== connection.tabId || message.documentId !== connection.documentId) return;
      if (message.url !== connection.url) await disconnect('The connected page changed. Connect this tab again.'); else void loop();
    }); return;
  }
  // Pairing authority belongs to our popup, never to a page/content script.
  if (sender.tab || !sender.url?.startsWith(chrome.runtime.getURL('popup.html'))) return;
  initialized.then(async () => {
    if (message?.action === 'status') return {connected: !!connection, url: connection?.url, title: connection?.title, pairing, lastError};
    if (message?.action === 'connect') return connectTab(message);
    if (message?.action === 'disconnect') { await disconnect(); return {connected: false}; }
    throw new Error('Unsupported popup action.');
  }).then(result => respond({result}), error => respond({error: error.message})); return true;
});
chrome.tabs.onRemoved.addListener(tabId => { initialized.then(() => { if (connection?.tabId === tabId) void disconnect('The connected tab closed.'); }); });
chrome.tabs.onUpdated.addListener((tabId, change) => { initialized.then(() => {
  if (connection?.tabId === tabId && (change.status === 'loading' || (change.url && safeUrl(change.url) !== connection.url))) void disconnect('The connected page navigated. Connect this tab again.');
}); });
initialized.then(() => { if (connection) void loop(); });
