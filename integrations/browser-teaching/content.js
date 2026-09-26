(() => {
  'use strict';
  // This runs in Chrome's isolated world. The page never sees pairing credentials.
  if (globalThis.__summonTeaching) return;
  const MAX_EVENTS = 24, RECORD_MS = 5 * 60_000;
  const documentId = crypto.randomUUID();
  const url = () => location.origin + location.pathname;
  let originalUrl = url();
  const squash = (value, max = 160) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const sensitiveName = /pass(word|code)?|secret|token|api.?key|credit|card.?number|cvc|cvv|ssn|social.?security|one.?time|otp|authenticator|billing|iban|routing|account.?number/i;
  const dangerousName = /\b(submit|send|pay|purchase|buy|checkout|delete|remove|erase|transfer|publish|post|order|subscribe|sign.?in|log.?in|connect.?wallet|approve.?transaction)\b/i;
  const safeKeys = new Set(); // Synthetic keyboard activation is not reliable across sites; teach clicks instead.
  let recording = false, intent = '', events = [], pendingFill = null, fillTimer = null, expiryTimer = null, expiresAt = 0, lastSnapshot = null, limitReason = '';
  const settling = new Set();
  const semanticClickSelector = 'button,a[href],[role="button"],[role="option"],[role="tab"],[role="radio"],[role="checkbox"],input[type="button"],input[type="submit"],[onclick]';
  const clickableSelector = semanticClickSelector + ',[tabindex]';
  function visible(element) {
    if (!(element instanceof Element) || !element.isConnected || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }
  function sensitive(element) {
    if (!(element instanceof Element)) return true;
    const type = (element.getAttribute('type') || '').toLowerCase();
    return ['password', 'hidden', 'email', 'tel', 'file'].includes(type) || element.isContentEditable || sensitiveName.test([element.getAttribute('name'), element.id, element.getAttribute('autocomplete'), element.getAttribute('aria-label'), element.getAttribute('placeholder')].filter(Boolean).join(' '));
  }
  function fillable(element) {
    return element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && ['text', 'search', 'number'].includes(element.type));
  }
  function label(element) {
    const aria = element.getAttribute('aria-label'); if (aria) return squash(aria);
    const ids = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    if (ids.length) { const value = squash(ids.map(id => document.getElementById(id)?.textContent || '').join(' ')); if (value) return value; }
    if (element.labels?.length) return squash([...element.labels].map(node => node.textContent).join(' '));
    if (element instanceof HTMLImageElement) return squash(element.alt || element.title);
    if (element.matches('input,textarea,select')) return squash(element.getAttribute('title') || element.getAttribute('placeholder') || element.getAttribute('name'));
    return squash(element.innerText || element.getAttribute('title') || element.querySelector('img[alt]')?.getAttribute('alt') || element.textContent);
  }
  function role(element) {
    return element.getAttribute('role') || ({BUTTON: 'button', A: 'link', INPUT: ['button', 'submit'].includes(element.type) ? 'button' : 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox', IMG: 'img'}[element.tagName] || '');
  }
  function descriptor(element) {
    const target = {tag: element.tagName.toLowerCase(), role: role(element), name: label(element)};
    if (element.getAttribute('placeholder')) target.placeholder = squash(element.getAttribute('placeholder'));
    if (element instanceof HTMLInputElement) target.inputType = element.type;
    // IDs are descriptive only. Replay never executes a model-supplied CSS selector.
    if (element.id && /^[A-Za-z][\w-]{0,79}$/.test(element.id)) target.selector = `#${element.id}`;
    return target;
  }
  function actionable(element) {
    if (!(element instanceof Element)) return null;
    for (let node = element, depth = 0; node && depth < 5; node = node.parentElement, depth++) {
      if (node.matches('body,html')) break;
      if (node.matches(semanticClickSelector)) return node;
      // Cursor inherits into image/text children; capture its boundary so replay
      // resolves the same tile, rather than a span we never enumerate later.
      const pointerBoundary = getComputedStyle(node).cursor === 'pointer' && (node.matches('[class*="cursor-pointer"],[style*="cursor"]') || !node.parentElement || getComputedStyle(node.parentElement).cursor !== 'pointer');
      if (pointerBoundary && label(node)) return node;
      if (node.hasAttribute('tabindex') && !node.hasAttribute('role') && !node.querySelector(semanticClickSelector) && label(node)) return node;
    }
    return null;
  }
  function candidates(kind) {
    if (kind === 'fill' || kind === 'press') return [...document.querySelectorAll('input,textarea')];
    if (kind === 'select') return [...document.querySelectorAll('select')];
    const found = new Set(document.querySelectorAll(clickableSelector));
    // Image-based custom tiles often expose their label only on the child image.
    for (const element of document.querySelectorAll('img[alt],[class*="cursor-pointer"],[style*="cursor"]')) {
      const parent = actionable(element); if (parent) found.add(parent);
    }
    return [...found].slice(0, 2000);
  }
  function snapshot(compact = false) {
    const controls = [], fieldValues = [];
    for (const element of [...new Set([...candidates('fill'), ...candidates('select'), ...candidates('click')])]) {
      if (!visible(element) || sensitive(element)) continue;
      const target = descriptor(element); if (!target.name && !target.placeholder && !target.selector) continue;
      if (element.matches('input,textarea,select')) fieldValues.push(`${target.name || target.placeholder || target.selector || 'Field'}: ${squash(element.value, 120)}`);
      controls.push(target); if (controls.length >= (compact ? 12 : 80)) break;
    }
    const maxText = compact ? 1400 : 4000;
    return {url: url(), text: squash(`Fields: ${fieldValues.join('; ')}. Page: ${document.body?.innerText || ''}`, maxText), controls};
  }
  function scope() {
    if (url() !== originalUrl) { stop(); throw new Error('This page changed. Connect this tab again.'); }
  }
  function stop() {
    recording = false; expiresAt = 0; clearTimeout(expiryTimer); clearTimeout(fillTimer); pendingFill = null;
  }
  function addEvent(kind, target, value, before) {
    if (!recording || events.length >= MAX_EVENTS) return;
    const event = {kind, target, ...(value !== undefined ? {value: squash(value, 500)} : {}), before: before || lastSnapshot || snapshot(true), after: null};
    events.push(event);
    const promise = new Promise(resolve => setTimeout(() => { event.after = snapshot(true); lastSnapshot = event.after; resolve(); }, 100));
    settling.add(promise); promise.finally(() => settling.delete(promise));
    if (events.length >= MAX_EVENTS) { recording = false; limitReason = 'This demonstration reached its 24-step limit. Teach a shorter procedure.'; clearTimeout(expiryTimer); }
  }
  function flushFill() {
    clearTimeout(fillTimer); const pending = pendingFill; pendingFill = null;
    if (pending) addEvent(pending.kind, pending.target, pending.value, pending.before);
  }
  function mayRecord(event) {
    if (!recording || !event.isTrusted || Date.now() > expiresAt) return false;
    try { scope(); return true; } catch { return false; }
  }
  document.addEventListener('input', event => {
    if (!mayRecord(event) || !fillable(event.target) || sensitive(event.target) || !visible(event.target)) return;
    if (pendingFill && pendingFill.element !== event.target) flushFill();
    if (!pendingFill) pendingFill = {kind: 'fill', element: event.target, target: descriptor(event.target), before: lastSnapshot || snapshot(true)};
    pendingFill.value = event.target.value; clearTimeout(fillTimer); fillTimer = setTimeout(flushFill, 300);
  }, true);
  document.addEventListener('change', event => {
    if (!mayRecord(event) || sensitive(event.target) || !visible(event.target)) return;
    if (event.target.matches?.('select')) { flushFill(); addEvent('select', descriptor(event.target), event.target.value, lastSnapshot); }
    else if (fillable(event.target)) flushFill();
  }, true);
  document.addEventListener('click', event => {
    if (!mayRecord(event)) return;
    flushFill(); const element = actionable(event.target);
    if (!element || sensitive(element) || !visible(element) || element.matches('input:not([type="button"]):not([type="submit"]),textarea,select')) return;
    const target = descriptor(element); if (!target.name) return;
    addEvent('click', target, undefined, snapshot(true));
  }, true);
  document.addEventListener('keydown', event => {
    if (!mayRecord(event) || !safeKeys.has(event.key) || !event.target.matches?.('input,textarea') || sensitive(event.target)) return;
    flushFill(); addEvent('press', descriptor(event.target), event.key, lastSnapshot);
  }, true);
  function resolveTarget(kind, target) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('A semantic target is required.');
    const named = ['name', 'placeholder'].some(key => typeof target[key] === 'string' && target[key].trim());
    // Some React Select comboboxes have no accessible name. The compiler keeps
    // this exact ID from the human recording; accept only a single identifier,
    // never a CSS expression or model-authored selector. Named targets continue
    // to resolve semantically so Najia -> Jessie does not keep Najia's old ID.
    const recordedId = typeof target.selector === 'string' && /^#[A-Za-z][\w-]{0,79}$/.test(target.selector) ? target.selector.slice(1) : null;
    if (!named && !recordedId) throw new Error('The target needs a visible name, placeholder, or recorded element ID.');
    const fields = ['tag', 'role', 'name', 'placeholder', 'inputType'];
    for (const key of fields) if (target[key] !== undefined && (typeof target[key] !== 'string' || target[key].length > 200)) throw new Error('Invalid semantic target.');
    const matches = candidates(kind).filter(element => {
      if (!visible(element) || sensitive(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
      if (!named && element.id !== recordedId) return false;
      const actual = descriptor(element);
      return fields.every(key => !target[key] || squash(actual[key]).toLocaleLowerCase() === squash(target[key]).toLocaleLowerCase());
    });
    if (matches.length !== 1) throw new Error(matches.length ? 'The target is ambiguous. Show Summon a more specific control.' : 'The demonstrated control is not visible on this page.');
    const element = matches[0], control = actionable(element) || element;
    if (dangerousName.test(label(control)) || (control instanceof HTMLButtonElement && control.type === 'submit' && control.form) || control.matches('input[type="submit"]')) throw new Error('This teaching prototype cannot submit, send, purchase, delete, or sign in.');
    if (kind === 'click' && element.matches('a[href]')) {
      const destination = new URL(element.getAttribute('href'), location.href);
      if (destination.origin !== location.origin || destination.pathname !== location.pathname || destination.protocol !== location.protocol || element.hasAttribute('download')) throw new Error('Teaching cannot navigate away from the connected page.');
    }
    return element;
  }
  async function execute(step) {
    scope(); if (recording) throw new Error('Finish the demonstration before asking Summon to act.');
    if (!step || !['fill', 'click', 'select', 'press'].includes(step.kind)) throw new Error('Unsupported teaching step.');
    const element = resolveTarget(step.kind, step.target), before = snapshot(), matched = descriptor(element);
    if (step.kind !== 'click' && (typeof step.value !== 'string' || step.value.length > 500)) throw new Error('Invalid field value.');
    if (step.kind === 'fill') {
      if (element instanceof HTMLInputElement && !['text', 'search', 'number'].includes(element.type)) throw new Error('Only ordinary text/search fields can be filled.');
      element.focus();
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, step.value);
      element.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: step.value}));
      element.dispatchEvent(new Event('change', {bubbles: true}));
    } else if (step.kind === 'select') {
      const options = [...element.options].filter(option => option.value === step.value || squash(option.text) === squash(step.value));
      if (options.length !== 1 || options[0].disabled) throw new Error('The requested option is missing or ambiguous.');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(element, options[0].value);
      element.dispatchEvent(new Event('input', {bubbles: true})); element.dispatchEvent(new Event('change', {bubbles: true}));
    } else if (step.kind === 'press') {
      if (!safeKeys.has(step.value)) throw new Error('Only navigation and Escape keys are supported.');
      element.focus(); element.dispatchEvent(new KeyboardEvent('keydown', {key: step.value, bubbles: true})); element.dispatchEvent(new KeyboardEvent('keyup', {key: step.value, bubbles: true}));
    } else element.click();
    await new Promise(resolve => setTimeout(resolve, 200)); scope();
    const after = snapshot(); return {before, after, matched, changed: JSON.stringify(before) !== JSON.stringify(after)};
  }
  async function command(method, payload = {}) {
    if (method === 'hello') { stop(); events = []; intent = ''; originalUrl = url(); startHeartbeat(); return {documentId, url: url(), title: squash(document.title, 200)}; }
    scope();
    if (method === 'snapshot') return snapshot();
    if (method === 'begin') {
      stop(); events = []; limitReason = ''; intent = squash(payload.intent, 1200); lastSnapshot = snapshot(true); recording = true; expiresAt = Date.now() + RECORD_MS;
      expiryTimer = setTimeout(() => { flushFill(); recording = false; limitReason = 'This demonstration expired after five minutes. Teach a shorter procedure.'; }, RECORD_MS);
      return {url: url(), title: squash(document.title, 200), recording, expiresAt, before: snapshot()};
    }
    if (method === 'cancel') { stop(); events = []; intent = ''; return {cancelled: true, url: url()}; }
    if (method === 'finish') {
      flushFill(); recording = false; clearTimeout(expiryTimer); await Promise.all([...settling]);
      if (limitReason) throw new Error(limitReason);
      return {url: url(), title: squash(document.title, 200), intent, events};
    }
    if (method === 'execute') return execute(payload.step);
    throw new Error('Unsupported teaching command.');
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.channel !== 'summon-teaching') return;
    if (message.documentId && message.documentId !== documentId) { respond({error: 'The connected document changed.'}); return; }
    Promise.resolve().then(() => command(message.method, message.payload)).then(result => respond({result}), error => respond({error: squash(error.message, 400)})); return true;
  });
  // A connected document sends a content-free heartbeat. The runtime API wakes
  // MV3 after browser sleep; no host-wide observer or browsing-history access.
  let heartbeat = null;
  function startHeartbeat() {
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (url() !== originalUrl) { stop(); clearInterval(heartbeat); }
      try { chrome.runtime.sendMessage({channel: 'summon-teaching-heartbeat', documentId, url: url()}).catch(() => { stop(); clearInterval(heartbeat); }); }
      catch { stop(); clearInterval(heartbeat); }
    }, 10_000);
  }
  addEventListener('pagehide', () => { stop(); clearInterval(heartbeat); }, {once: true});
  globalThis.__summonTeaching = {documentId};
})();
