import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, LoaderCircle, Mic, MicOff, X } from 'lucide-react';
import type { VoiceWidgetSnapshot } from './types';
import './widget.css';

/* Intent: The person can glance at the desk and know whether Summon can hear them.
   Hierarchy: the 48px microphone is the single focal control; the actual state
   sits beside it, with open/hide quiet at the edge. Domain: wake word, command,
   local capture, off switch, workspace. Paper, raised paper, inset paper, ink
   and petrol inherit the workbench's desk palette. A fine edge and one quiet
   shadow lift the capsule above the desktop. System-native type uses 12px/600
   for state, 10px/500 for identity, 10px/400 for capture truth. 4px rhythm,
   8px padding, 40px secondary targets. No fake waveform or activity meter. */

const bridge = window.summonWidget;
const initial: VoiceWidgetSnapshot = { state: 'connecting', mode: 'off', micActive: false, available: false };

function stateLabel(value: VoiceWidgetSnapshot): string {
  if (!bridge) return 'Widget preview';
  if (value.state === 'connecting') return 'Connecting…';
  if (value.state === 'stopping') return 'Stopping…';
  if (value.state === 'error') return 'Voice needs attention';
  if (value.state === 'starting') return 'Starting…';
  if (value.state === 'hearing') return 'Hearing you…';
  if (value.state === 'finishing') return 'Waiting for a pause…';
  if (value.state === 'transcribing') return 'Transcribing…';
  if (value.state === 'processing') return 'Working on command…';
  if (value.state === 'awake') return 'Summon heard you';
  if (value.micActive) return value.mode === 'handsfree' ? 'Listening for Summon' : 'Listening to you';
  if (!value.available) return 'Voice unavailable';
  return 'Listening is off';
}

function VoiceWidget() {
  const [snapshot, setSnapshot] = useState(initial);
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let active = true, receivedUpdate = false;
    const unsubscribe = bridge.onUpdate(value => {
      if (active) { receivedUpdate = true; setSnapshot(value); setActionError(''); }
    });
    bridge.snapshot().then(value => { if (active && !receivedUpdate) setSnapshot(value); }).catch(error => {
      if (active && !receivedUpdate) { setSnapshot({ ...initial, state: 'error' }); setActionError(error instanceof Error ? error.message : String(error)); }
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  async function invoke(action: () => Promise<void>) {
    setActionError(''); setPending(true);
    try { await action(); }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  }

  const active = snapshot.mode !== 'off' || snapshot.micActive;
  const waiting = ['starting', 'stopping', 'transcribing', 'processing', 'connecting'].includes(snapshot.state);
  const error = actionError || snapshot.error || '';
  const label = actionError ? 'Could not complete action' : stateLabel(snapshot);
  const detail = !bridge ? 'Open the installed app' : snapshot.micActive ? 'Microphone on · local' : 'Microphone off';
  const hint = error || (snapshot.available ? 'Drag here to move Summon' : 'Open Summon to set up local voice');

  return <main className={`voice-widget ${snapshot.micActive ? 'mic-live' : ''} ${error || snapshot.state === 'error' ? 'needs-attention' : ''}`} aria-label="Summon voice widget">
    <button className={`widget-mic ${snapshot.micActive ? 'active' : ''}`} type="button" aria-label={active ? 'Stop listening' : 'Start listening'} aria-pressed={active}
      disabled={!bridge || ((!snapshot.available || pending) && !active) || snapshot.state === 'stopping'}
      title={active ? 'Stop listening and cancel unfinished voice input' : snapshot.available ? 'Start listening for Summon' : 'Set up local voice in Summon'}
      onClick={() => bridge && void invoke(() => bridge.toggleListening())}>
      {waiting ? <LoaderCircle className="widget-spinner" size={23} /> : snapshot.micActive ? <Mic size={23} /> : <MicOff size={23} />}
    </button>
    <div className="widget-readout" title={hint}>
      <span className="widget-brand">summon<span className={`widget-mic-dot ${snapshot.micActive ? 'on' : ''}`} /></span>
      <strong role="status" aria-live="polite">{label}</strong>
      <span className="widget-capture" aria-live="polite">{detail}</span>
      {error && <span className="widget-sr-only" role="alert">{error}</span>}
    </div>
    <button className="widget-button" type="button" aria-label="Open Summon" title="Open Summon" disabled={!bridge} onClick={() => bridge && void invoke(() => bridge.openSummon())}><ArrowUpRight size={19} /></button>
    <button className="widget-button widget-hide" type="button" aria-label="Hide voice widget" title="Hide widget and stop listening" disabled={!bridge} onClick={() => bridge && void invoke(() => bridge.hide())}><X size={16} /></button>
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><VoiceWidget /></React.StrictMode>);
