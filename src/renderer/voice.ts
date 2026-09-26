import type { VoiceMode, VoiceStatus } from './types';

type Segment = { audio: ArrayBuffer; mode: VoiceMode; token: number };
const END_PAUSE_SECONDS = 0.8;
const MIN_SPEECH_RMS = 0.012;

export function encodeWav(chunks: Float32Array[], sampleRate: number): ArrayBuffer {
  const count = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + count * 2), view = new DataView(buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, count * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const sample of chunk) { const value = Math.max(-1, Math.min(1, sample)); view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true); offset += 2; }
  return buffer;
}

// The workbench owns the only capture controller. Menu-bar controls request
// modes through main; importing this module does not open a mic.
export function installVoiceController(): () => void {
  const bridge = window.summon;
  if (!bridge) return () => {};
  let mode: VoiceMode = 'off', generation = 0, disposed = false;
  let stream: MediaStream | null = null, context: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null, source: MediaStreamAudioSourceNode | null = null, mute: GainNode | null = null;
  let frames: Float32Array[] = [], preroll: Float32Array[] = [], voiced = 0, quiet = 0, duration = 0, started = false;
  let speechLevel = 0, noiseFloor = 0.003;
  let capturePhase: 'waiting' | 'hearing' | 'finishing' = 'waiting';
  let busy = false, wakeUntil = 0, pending: Segment[] = [], enrolling = false, enrollCount = 0;
  let captureTimer: ReturnType<typeof setTimeout> | undefined;
  let trackCleanup: (() => void)[] = [];
  const current = (token: number) => !disposed && token === generation;
  const micActive = () => Boolean(stream?.getAudioTracks().some(track => track.readyState === 'live' && track.enabled));

  function status(state: string, text?: string) {
    const enrollment = enrolling ? { count: enrollCount, total: 10, phase: (['hearing', 'finishing'].includes(state) ? 'hearing' : 'listening') as 'hearing' | 'listening' } : undefined;
    const detail: VoiceStatus = { state, mode, micActive: micActive(), ...(text ? { text } : {}), ...(enrollment ? { enrollment } : {}) };
    window.dispatchEvent(new CustomEvent('summon:voice-status', { detail }));
    void bridge!.voiceState(detail).catch(() => {});
  }
  function enrollStatus(phase: 'captured' | 'done', text: string) {
    const detail: VoiceStatus = { state: phase === 'done' ? 'listening' : 'hearing', mode, micActive: micActive(), text, enrollment: { count: enrollCount, total: 10, phase } };
    window.dispatchEvent(new CustomEvent('summon:voice-status', { detail }));
    void bridge!.voiceState(detail).catch(() => {});
  }
  function resetSegment() { frames = []; preroll = []; voiced = 0; quiet = 0; duration = 0; started = false; speechLevel = 0; capturePhase = 'waiting'; }
  function stopCapture() {
    clearTimeout(captureTimer); captureTimer = undefined;
    trackCleanup.forEach(cleanup => cleanup()); trackCleanup = [];
    if (processor) processor.onaudioprocess = null;
    if (context) context.onstatechange = null;
    processor?.disconnect(); source?.disconnect(); mute?.disconnect();
    processor = null; source = null; mute = null;
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    const previousContext = context; context = null;
    if (previousContext && previousContext.state !== 'closed') void previousContext.close().catch(() => {});
  }
  function cancel(state = 'off', text?: string) {
    generation++; mode = 'off'; pending = []; wakeUntil = 0; noiseFloor = 0.003;
    stopCapture(); resetSegment(); status(state, text);
  }
  function fail(error: unknown) { if (enrolling) { enrolling = false; enrollCount = 0; bridge!.cancelEnrollment().catch(() => {}); } cancel('error', error instanceof Error ? error.message : String(error)); }

  function finishSegment() {
    if (!context || mode === 'off') return;
    const capturedMode = mode, token = generation, sampleRate = context.sampleRate;
    if (voiced < 0.2) { resetSegment(); return; }
    const audio = encodeWav(frames, sampleRate); resetSegment();
    if (capturedMode === 'command') { stopCapture(); status('transcribing'); }
    // Keep one next utterance while wake detection/transcription is in flight.
    // “Summon” followed by a separate command can then survive processing time.
    if (pending.length === 0) pending.push({ audio, mode: capturedMode, token });
    void drainSegments();
  }

  async function processSegment(segment: Segment) {
    const { audio, mode: capturedMode, token } = segment;
    if (!current(token)) return;
    try {
      // Enrollment mode: feed audio to the speaker worker instead of the normal pipeline.
      if (enrolling) {
        const result = await bridge!.enrollSpeaker(audio);
        if (!current(token)) return;
        if (result.error) return;
        enrollCount = result.count;
        if (result.count >= 10) {
          await bridge!.finishEnrollment();
          enrolling = false;
          enrollStatus('done', 'Voice enrolled. Speaker verification is now active.');
        } else {
          enrollStatus('captured', `Sample ${result.count} of 10 captured.`);
        }
        return;
      }
      let wakeDetected = false, armed = false;
      if (capturedMode === 'handsfree') {
        // Speaker verification gate: reject non-enrolled-speaker audio before wake-word detection.
        const speaker = await bridge!.verifySpeaker(audio);
        if (!current(token)) return;
        if (!speaker.verified) { status('listening'); return; }
        armed = Date.now() < wakeUntil; wakeUntil = 0;
        if (!armed) {
          if (!bridge!.detectWake) throw new Error('Dedicated wake detection is unavailable. Use the microphone button.');
          status('checking-wake', 'Listening for “Summon”…');
          const wake = await bridge!.detectWake(audio);
          if (!current(token)) return;
          if (!wake.detected) { status('listening'); return; }
          wakeDetected = true; status('awake', 'Summon heard you.');
        }
      }
      // Whisper receives only a one-shot command, a positive wake detection,
      // or speech within the brief command window after a wake-only phrase.
      status('transcribing');
      const answer = await bridge!.transcribe(audio);
      if (!current(token)) return;
      let text = answer.text.trim();
      if (capturedMode === 'handsfree') {
        const wake = text.match(/^(?:hey[,\s]+)?summon\b[\s,.!?:-]*(.*)$/i);
        if (wake) {
          text = wake[1].trim();
          if (!text) { wakeUntil = Date.now() + 8000; status('listening', 'Say your command.'); return; }
        } else if (wakeDetected && !armed) {
          // A KWS near-match without the spoken prefix grants no command window.
          status('listening', 'Wake phrase unclear; try “Summon” again.'); return;
        }
      }
      if (!text) {
        if (capturedMode === 'command') mode = 'off';
        status(capturedMode === 'handsfree' ? 'listening' : 'transcribed', 'No speech recognized. Try speaking closer to the microphone.');
        return;
      }
      status('processing', text);
      // Off/sleep/unmount invalidate this token before any queued dispatch.
      if (!current(token)) return;
      const result = await bridge!.command(text);
      if (!current(token)) return;
      window.dispatchEvent(new CustomEvent('summon:voice-result', { detail: { text, result } }));
      if (capturedMode === 'command') mode = 'off';
      status(capturedMode === 'handsfree' ? 'listening' : 'transcribed', text);
    } catch (error) { if (current(token)) fail(error); }
  }

  async function drainSegments() {
    if (busy) return;
    busy = true;
    try { while (pending.length) { const segment = pending.shift(); if (segment) await processSegment(segment); } }
    finally {
      busy = false;
      // Capture can continue while the previous hands-free utterance is being
      // checked. Restore the phase of that next utterance once processing ends.
      if (mode === 'handsfree' && started) status(capturePhase === 'finishing' ? 'finishing' : 'hearing');
    }
  }

  async function setMode(next: VoiceMode) {
    if (disposed) return;
    // Off always cancels, including a one-shot with partial speech. Silence
    // ends a complete utterance; the stop control never submits it.
    cancel();
    if (next === 'off') return;
    const token = generation; mode = next; status('starting');
    try {
      const input = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (!current(token)) { input.getTracks().forEach(track => track.stop()); return; }
      stream = input;
      if (!micActive()) throw new Error('The microphone did not provide an active audio track.');
      for (const track of input.getAudioTracks()) {
        const ended = () => { if (current(token)) fail(new Error('Microphone disconnected. Turn listening on to try again.')); };
        const muted = () => { if (current(token)) fail(new Error('Microphone input was interrupted. Turn listening on to try again.')); };
        track.addEventListener('ended', ended); track.addEventListener('mute', muted);
        trackCleanup.push(() => { track.removeEventListener('ended', ended); track.removeEventListener('mute', muted); });
      }
      status('starting');
      // Resample device input here: external microphones may run at 96 kHz,
      // while the local transcription service accepts PCM up to 48 kHz.
      const audioContext = new AudioContext({ sampleRate: 48000 }); context = audioContext;
      await audioContext.resume();
      if (!current(token) || context !== audioContext) {
        input.getTracks().forEach(track => track.stop());
        if (audioContext.state !== 'closed') void audioContext.close().catch(() => {});
        return;
      }
      if (!micActive() || audioContext.state !== 'running') throw new Error('Microphone capture could not start. Check the microphone settings.');
      source = audioContext.createMediaStreamSource(input);
      processor = audioContext.createScriptProcessor(4096, 1, 1);
      mute = audioContext.createGain(); mute.gain.value = 0;
      source.connect(processor); processor.connect(mute); mute.connect(audioContext.destination);
      audioContext.onstatechange = () => {
        if (current(token) && context === audioContext && audioContext.state !== 'running') fail(new Error('Audio capture was interrupted. Listening is off.'));
      };
      processor.onaudioprocess = event => {
        if (!current(token) || context !== audioContext || mode === 'off') return;
        const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
        let sum = 0; for (const value of chunk) sum += value * value;
        const seconds = chunk.length / audioContext.sampleRate, rms = Math.sqrt(sum / chunk.length);
        // A fixed threshold mistakes a fan/noise floor for continuing speech.
        // Adapt only within a narrow range: use quiet observations plus the
        // recent voiced level, not a permanent peak that would clip softer words.
        // This remains an amplitude gate, not a learned speech detector.
        const adaptive = started ? Math.max(noiseFloor * 1.5, speechLevel * 0.22) : noiseFloor * 2;
        const threshold = Math.max(MIN_SPEECH_RMS, Math.min(0.03, adaptive));
        const speech = rms > threshold;
        if (speech) speechLevel = speechLevel ? speechLevel + (rms - speechLevel) * (1 - Math.exp(-seconds / 0.25)) : rms;
        else noiseFloor += (Math.min(rms, 0.012) - noiseFloor) * (1 - Math.exp(-seconds / 0.2));
        if (!started) {
          preroll.push(chunk); if (preroll.length > 3) preroll.shift(); if (!speech) return;
          started = true; frames = [...preroll]; preroll = [];
        } else frames.push(chunk);
        duration += seconds;
        if (speech) {
          voiced += seconds; quiet = 0;
          if (capturePhase !== 'hearing') { capturePhase = 'hearing'; if (!busy) status('hearing'); }
        } else {
          quiet += seconds;
          if (quiet >= 0.2 && capturePhase !== 'finishing') { capturePhase = 'finishing'; if (!busy) status('finishing'); }
        }
        if ((quiet >= END_PAUSE_SECONDS && voiced > 0.2) || duration > 18) finishSegment();
      };
      status(next === 'handsfree' ? 'listening' : 'recording');
      if (next === 'command') captureTimer = setTimeout(() => {
        if (current(token) && mode === 'command') { if (started) finishSegment(); else cancel('off', 'No speech detected.'); }
      }, 22000);
    } catch (error) { if (current(token)) fail(error); }
  }

  const requestedMode = (next: VoiceMode) => { if (['off', 'command', 'handsfree'].includes(next)) void setMode(next); };
  const modeListener = (event: Event) => requestedMode((event as CustomEvent<VoiceMode>).detail);
  window.addEventListener('summon:voice-mode', modeListener);
  const enrollListener = async () => {
    try {
      await bridge!.beginEnrollment();
      enrolling = true;
      enrollCount = 0;
      void setMode('handsfree');
    } catch (error) { status('error', error instanceof Error ? error.message : String(error)); }
  };
  const unsubscribeEnroll = bridge.onEnrollSpeaker(enrollListener);
  const startEnrollHandler = () => void enrollListener();
  window.addEventListener('summon:start-enrollment', startEnrollHandler);
  const cancelEnrollHandler = () => {
    if (enrolling) { enrolling = false; enrollCount = 0; void bridge!.cancelEnrollment().catch(() => {}); cancel('off', 'Enrollment cancelled.'); }
  };
  window.addEventListener('summon:cancel-enrollment', cancelEnrollHandler);
  const unsubscribeToggle = bridge.onVoiceToggle(() => requestedMode(mode === 'off' ? 'command' : 'off'));
  const unsubscribeMode = bridge.onVoiceMode(requestedMode);
  const unload = () => { if (!disposed) { if (enrolling) { enrolling = false; enrollCount = 0; bridge!.cancelEnrollment().catch(() => {}); } cancel(); disposed = true; } };
  window.addEventListener('beforeunload', unload);
  status('off');
  return () => {
    unload(); unsubscribeToggle(); unsubscribeMode(); unsubscribeEnroll();
    window.removeEventListener('summon:voice-mode', modeListener);
    window.removeEventListener('beforeunload', unload);
    window.removeEventListener('summon:start-enrollment', startEnrollHandler);
    window.removeEventListener('summon:cancel-enrollment', cancelEnrollHandler);
  };
}
