'use strict';
const status = document.querySelector('#status'), form = document.querySelector('#pair'), connect = document.querySelector('#connect'), disconnect = document.querySelector('#disconnect');
const show = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); };
const connectionInput = document.querySelector('#connection');
function readConnection() {
  if (!connectionInput.value.trim()) return;
  let value; try { value = JSON.parse(connectionInput.value); } catch { throw new Error('Paste the complete connection copied from Summon.'); }
  if (!value || !Number.isInteger(value.port) || typeof value.token !== 'string') throw new Error('The connection needs a port and pairing token.');
  document.querySelector('#port').value = value.port; document.querySelector('#token').value = value.token;
}
connectionInput.addEventListener('input', () => { try { readConnection(); } catch {} });
async function send(message) { const response = await chrome.runtime.sendMessage(message); if (response?.error) throw new Error(response.error); return response.result; }
async function refresh() {
  const state = await send({action: 'status'});
  document.querySelector('#port').value = state.pairing?.port || ''; document.querySelector('#token').value = state.pairing?.token || '';
  disconnect.hidden = !state.connected;
  show(state.connected ? `Connected: ${state.title || state.url}` : state.lastError || 'Copy the connection details from Summon to begin.', !!state.lastError);
}
form.addEventListener('submit', async event => {
  event.preventDefault(); connect.disabled = true; show('Connecting this tab…');
  try { readConnection(); const [tab] = await chrome.tabs.query({active: true, currentWindow: true}); await send({action: 'connect', tabId: tab.id, port: Number(document.querySelector('#port').value), token: document.querySelector('#token').value.trim()}); await refresh(); }
  catch (error) { show(error.message, true); } finally { connect.disabled = false; }
});
disconnect.addEventListener('click', async () => { try { await send({action: 'disconnect'}); await refresh(); } catch (error) { show(error.message, true); } });
refresh().catch(error => show(error.message, true));
