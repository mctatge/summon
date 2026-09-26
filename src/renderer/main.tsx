import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity as ActivityIcon, ArrowDownToLine, ArrowRight, ArrowUpRight, CalendarDays, Check, ChevronDown, CircleHelp, Command, ExternalLink, File, FileSpreadsheet, FileText, Folder, FolderOpen, Gauge, GitBranch, Headphones, History, Inbox, Keyboard, LoaderCircle, MapPin, Mic, MicOff, Monitor, NotebookText, LayoutDashboard, Palette, Pause, Play, Plus, Search, Settings2, ShieldCheck, Sparkles, Square, X } from 'lucide-react';
import type { ClaudeHooksStatus, CommandResult, LocalProposal, FileRecord, SettingsPatch, Snapshot, UsageReport, UsageSettings, UsageView, VoiceMode, VoiceStatus } from './types';
import { KnowledgePanel } from './KnowledgePanel';
import { WorkInFlightPanel } from './WorkInFlightPanel';
import { SessionsPanel } from './SessionsPanel';
import { VisualWorkspacePanel } from './VisualWorkspacePanel';
import { Network } from 'lucide-react';
import { Bot } from 'lucide-react';
import type { AgentSessionsView } from './types';
import { previewAgentSessions } from './preview';
import { previewSnapshot } from './preview';
import './styles.css';
import './workspace.css';
import { AccentPicker } from './AccentPicker';
import { accentVariables } from './appearance';
import { WorkOverviewCard, SessionsOverviewCard, UsageOverviewCard } from './WorkspaceOverview';
import { NewTaskDialog } from './NewTaskDialog';
import { installVoiceController } from './voice';

/* Approved soft monochrome workspace: one person moving between agent tasks.
   The command card leads; real work, attention and allowance support it. Gray
   desk, white paper, graphite by default, surface depth and 4px spacing. The
   accent is one saved choice; semantic status colors retain their meaning. */

const bridge = window.summon;
const preview = !bridge;
const dateTime = (value: string) => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
// The usage meter in words: unknown usage is a status, never 0 %.
const resetWords = (value: string | null) => value ? `resets ${Date.parse(value) - Date.now() < 22 * 3600_000 ? time(value) : dateTime(value)}` : '';
const usageWords = (report: UsageReport | null) => {
  if (!report) return 'Not read yet.';
  if (report.status === 'ok') return report.windows.length ? report.windows.map(window => `${window.label} ${Math.round(window.usedPercent)}% used${window.resetsAt ? `, ${resetWords(window.resetsAt)}` : ''}`).join(' · ') : 'Signed in; this plan reports no windows.';
  return { not_signed_in: 'Not signed in. Sign in with the CLI, then refresh.', not_installed: 'Not installed on this Mac.', not_applicable: 'No plan limits to show (not signed in, or an API key).', error: report.error || 'Could not be read.' }[report.status];
};
const usageChip = (report: UsageReport | null) => !report ? 'No reading' : report.status !== 'ok' ? { not_signed_in: 'Not signed in', not_installed: 'Not installed', not_applicable: 'No plan', error: 'Error' }[report.status] : report.stale ? 'Stale' : 'Current';
const usageChecked = (usage?: UsageView) => { const times = usage ? Object.values(usage.providers).map(report => report?.fetchedAt).filter((value): value is string => Boolean(value)).sort() : []; return times.length ? `Checked ${dateTime(times[times.length - 1])}` : 'Not checked yet.'; };
const fileDate = (file: FileRecord) => [file.filingAt, file.modifiedAt, file.createdAt].filter((value): value is string => Boolean(value)).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || file.firstSeenAt;
const shortDate = (value: string) => new Date(value).toDateString() === new Date().toDateString() ? time(value) : new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' });
const folder = (path: string) => path.split('/').filter(Boolean).slice(0, -1).slice(-2).join(' / ') || 'Unknown folder';
const size = (bytes: number) => bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
const workbook = (file: FileRecord) => /\.(xlsx?|xlsm|csv|numbers)$/i.test(file.name);
const source = (file: FileRecord) => {
  if (file.sourceUrl) { try { return new URL(file.sourceUrl).hostname.replace(/^www\./, ''); } catch { /* Show filesystem provenance when URL metadata is invalid. */ } }
  return file.originalPath ? folder(file.originalPath) : 'Source not recorded';
};
const statusText = (file: FileRecord) => ({ present: 'Located', missing: 'Not found', filed: 'Filing receipt', waiting: 'In intake', unconfirmed: 'Access needed' }[file.status]);

function Glyph({ file, small = false }: { file: FileRecord; small?: boolean }) {
  const Icon = workbook(file) ? FileSpreadsheet : /\.(pdf|docx?|md|txt)$/i.test(file.name) ? FileText : File;
  return <span className={`file-glyph ${workbook(file) ? 'workbook' : ''} ${small ? 'small' : ''}`}><Icon size={small ? 17 : 21} strokeWidth={1.6} /></span>;
}

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" className="toggle" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(preview ? previewSnapshot : null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [result, setResult] = useState<CommandResult | null>(null);
  const [answer, setAnswer] = useState('');
  const [answerEngine, setAnswerEngine] = useState('');
  const [answerReason, setAnswerReason] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(preview ? 'forecast' : null);
  const [filter, setFilter] = useState<'all' | 'workbooks' | 'workspace'>('all');
  const [voice, setVoice] = useState<VoiceStatus>({ state: 'off', mode: 'off', micActive: false });
  const [showVoice, setShowVoice] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [page, setPage] = useState<'overview' | 'files'>('overview');
  const workspaceMain = useRef<HTMLDivElement>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const newTaskButton = useRef<HTMLButtonElement>(null);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [showWorkInFlight, setShowWorkInFlight] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [showVisuals, setShowVisuals] = useState(false);
  const [sessionTotals, setSessionTotals] = useState<AgentSessionsView['totals'] | null>(preview ? previewAgentSessions.totals : null);
  const [routineReceipt, setRoutineReceipt] = useState<CommandResult|null>(null);
  const [proposal, setProposal] = useState<LocalProposal|null>(null);
  const [enrollment, setEnrollment] = useState<VoiceStatus['enrollment'] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);

  useEffect(() => { workspaceMain.current?.scrollTo({ top: 0 }); }, [page]);

  useEffect(() => {
    const variables = accentVariables(snapshot?.settings.accentColor);
    for (const [name, value] of Object.entries(variables)) document.documentElement.style.setProperty(name, value);
  }, [snapshot?.settings.accentColor]);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    bridge.snapshot().then(value => { if (active) setSnapshot(value); }).catch(err => { if (active) setError(String(err.message || err)); });
    const unsub = bridge.onUpdate(value => { if (active) setSnapshot(value); });
    return () => { active = false; unsub(); };
  }, []);

  useEffect(() => {
    const listener = (event: Event) => {
      const next = (event as CustomEvent<VoiceStatus>).detail;
      setVoice(next);
      if (next.enrollment) setEnrollment(next.enrollment);
      else setEnrollment(prev => prev?.phase === 'done' ? prev : null);
      if (next.state === 'processing' && next.text) setQuery(next.text);
    };
    const resultListener = (event: Event) => {
      const { text, result: response } = (event as CustomEvent<{ text: string; result: CommandResult }>).detail;
      setPage('files');
      setQuery(text); setSubmitted(text); setResult(response); setProposal(null); setAnswer(''); setAnswerEngine(''); setAnswerReason('');
      if (response.fileIds?.length) { setSelectedId(response.fileIds[0]); setFilter('all'); }
      void bridge?.showWindow().catch(err => setError(err instanceof Error ? err.message : String(err)));
    };
    window.addEventListener('summon:voice-status', listener);
    window.addEventListener('summon:voice-result', resultListener);
    const stopVoice = installVoiceController();
    return () => { stopVoice(); window.removeEventListener('summon:voice-status', listener); window.removeEventListener('summon:voice-result', resultListener); };
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); input.current?.focus(); input.current?.select(); }
      if (event.key === 'Escape' && !showNewTask && !showSettings && !showKnowledge && !showWorkInFlight && !showSessions && !showVisuals) { setShowVoice(false); setResult(null); setAnswer(''); setQuery(''); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [showSettings, showKnowledge, showWorkInFlight, showSessions, showVisuals, showNewTask]);

  useEffect(() => {
    // ⌘G toggles Work in flight while no other panel is open.
    const listener = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'g' || showNewTask || showSettings || showKnowledge || showSessions || showVisuals) return;
      event.preventDefault();
      setShowWorkInFlight(value => !value);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [showSettings, showKnowledge, showSessions, showVisuals, showNewTask]);

  useEffect(() => {
    // ⌘E toggles Agent sessions while no other panel is open.
    const listener = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'e' || showNewTask || showSettings || showKnowledge || showWorkInFlight || showVisuals) return;
      event.preventDefault();
      setShowSessions(value => !value);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [showSettings, showKnowledge, showWorkInFlight, showVisuals, showNewTask]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== 'v' || showNewTask || showSettings || showKnowledge || showWorkInFlight || showSessions) return;
      // Preserve the standard paste-without-formatting shortcut while a text field is being edited.
      if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]')) return;
      event.preventDefault(); setShowVisuals(value => !value);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [showSettings, showKnowledge, showWorkInFlight, showSessions, showNewTask]);

  useEffect(() => {
    // The menu bar opens a panel here; the main process has already brought the window forward.
    // An older window may not have this subscription, so it is checked before use.
    if (!bridge || typeof bridge.onOpenPanel !== 'function') return;
    return bridge.onOpenPanel((panel: string) => {
      if (panel === 'agent-sessions') { setShowVisuals(false); setShowWorkInFlight(false); setShowSessions(true); }
      else if (panel === 'work-in-flight') { setShowVisuals(false); setShowSessions(false); setShowWorkInFlight(true); }
    });
  }, []);

  useEffect(() => {
    // The quick-access count checks agent sessions every 20 s, only while this window is visible.
    // While the panel is open it reports its own checks instead.
    if (!bridge || typeof bridge.agentSessions !== 'function' || showSessions || page === 'overview') return;
    let active = true;
    let busy = false;
    let timer = 0;
    const pull = () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      bridge.agentSessions().then(view => { if (active) setSessionTotals(view.totals); }).catch(() => { /* The next check retries. */ }).finally(() => { busy = false; });
    };
    const restart = () => {
      window.clearInterval(timer);
      timer = 0;
      if (document.visibilityState !== 'visible') return;
      pull();
      timer = window.setInterval(pull, 20_000);
    };
    restart();
    document.addEventListener('visibilitychange', restart);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', restart); };
  }, [showSessions, page]);

  const run = async (task: () => Promise<unknown>, lock = false) => {
    if (lock) setBusy(true);
    setError('');
    try { await task(); return true; } catch (err) { setError(err instanceof Error ? err.message : String(err)); return false; }
    finally { if (lock) setBusy(false); }
  };

  const command = async (text: string) => {
    if (!text.trim() || busy) return;
    setPage('files');
    setQuery(text); setSubmitted(text); setProposal(null); setAnswer(''); setAnswerEngine(''); setAnswerReason('');
    await run(async () => {
      const response = bridge ? await bridge.command(text) : { kind: 'files' as const, message: 'Preview results. Native commands work in the installed app.', fileIds: previewSnapshot.files.filter(file => /excel|workbook/i.test(text) ? workbook(file) : file.name.toLowerCase().includes(text.toLowerCase())).map(file => file.id) };
      setResult(response);
      if (response.fileIds?.length) { setSelectedId(response.fileIds[0]); setFilter('all'); }
      if (bridge) setSnapshot(await bridge.snapshot());
    }, true);
  };

  const updateSettings = async (patch: SettingsPatch) => {
    if (preview) {
      setSnapshot(value => value ? { ...value, settings: { ...value.settings, ...patch } } : value);
      return true;
    }
    return run(async () => setSnapshot(await bridge!.settings(patch)), true);
  };

  const setVoiceMode = (mode: VoiceMode) => {
    if (!bridge) return;
    window.dispatchEvent(new CustomEvent('summon:voice-mode', { detail: mode }));
    setShowVoice(false);
  };
  const startEnrollment = () => { setShowVoice(false); setShowSettings(false); window.dispatchEvent(new Event('summon:start-enrollment')); };
  const cancelEnrollment = () => { window.dispatchEvent(new Event('summon:cancel-enrollment')); setEnrollment(null); };
  const dismissEnrollment = () => setEnrollment(null);

  const filteredFiles = useMemo(() => {
    if (!snapshot) return [];
    let files = [...snapshot.files];
    if (result?.kind === 'files' && result.fileIds) { const ids = new Set(result.fileIds); files = files.filter(file => ids.has(file.id)); }
    if (filter === 'workbooks') files = files.filter(workbook);
    if (filter === 'workspace') files = files.filter(file => snapshot.currentProjectId && file.projectId === snapshot.currentProjectId);
    return files;
  }, [snapshot, filter, result]);
  const selected = snapshot?.files.find(file => file.id === selectedId) || null;
  const currentProject = snapshot?.projects.find(project => project.id === snapshot.currentProjectId);
  const handsFreeMode = voice.mode === 'handsfree';
  const voiceActive = voice.mode !== 'off' || voice.micActive;
  const voiceLabel = ({ off: 'Microphone off', starting: 'Starting microphone', stopping: 'Stopping microphone', recording: 'Listening to your command', hearing: 'Hearing you', finishing: 'Waiting for a pause', listening: 'Listening for "Summon"', 'checking-wake': 'Listening for "Summon"', awake: 'Summon heard you', transcribing: 'Transcribing on this Mac', processing: 'Working on your command', error: 'Voice needs attention', transcribed: 'Microphone off' } as Record<string, string>)[voice.state] || 'Voice status unavailable';

  if (!snapshot) return <main className="boot-screen"><div className="summon-mark"><Command size={23} /></div><h1>Summon</h1><p>{error || 'Connecting to your local activity…'}</p>{error ? <button className="button" onClick={() => run(async () => setSnapshot(await bridge!.snapshot()))}>Try again</button> : <LoaderCircle className="spinner" size={20} />}</main>;

  return <div className="app-shell">
    <header className="titlebar">
      <div className="wordmark"><Command size={21} strokeWidth={2} /><span>summon</span></div>
      <div className="titlebar-actions">
        {preview ? <span className="preview-badge">Preview · sample data</span> : <button className="observation-status" onClick={() => run(async () => setSnapshot(await bridge!.settings({ paused: !snapshot.settings.paused })))} title={snapshot.settings.paused ? 'Resume observation' : 'Pause observation'}><span className={`status-dot ${snapshot.settings.paused ? 'paused' : snapshot.health.watching ? '' : 'paused'}`} />{snapshot.settings.paused ? 'Paused' : snapshot.health.watching ? 'Observing locally' : 'Starting'}{snapshot.settings.paused ? <Play size={13} /> : <Pause size={13} />}</button>}
        <AccentPicker compact value={snapshot.settings.accentColor} disabled={busy} onChange={color => updateSettings({ accentColor: color })} />
      </div>
    </header>

    <div className="workspace-frame">
      <nav className="workspace-rail" aria-label="Main navigation">
        <button className={`workspace-nav-button ${page === 'overview' ? 'is-active' : ''}`} aria-label="Overview" aria-current={page === 'overview' ? 'page' : undefined} onClick={() => setPage('overview')}><LayoutDashboard size={20} /><span>Overview</span></button>
        <button className="workspace-nav-button" aria-label="Agent sessions" title="Agent sessions (⌘E)" data-sessions-opener="" onClick={() => setShowSessions(true)}><Bot size={20} /><span>Agents</span>{sessionTotals && sessionTotals.needsYou > 0 && <span className="workspace-nav-count" aria-label={`${sessionTotals.needsYou} need you`}>{sessionTotals.needsYou}</span>}</button>
        <button className="workspace-nav-button" aria-label="Work in flight" title="Work in flight (⌘G)" onClick={() => setShowWorkInFlight(true)}><GitBranch size={20} /><span>Work</span></button>
        <button className={`workspace-nav-button ${page === 'files' ? 'is-active' : ''}`} aria-label="Files" aria-current={page === 'files' ? 'page' : undefined} onClick={() => setPage('files')}><FolderOpen size={20} /><span>Files</span></button>
        <button className="workspace-nav-button" aria-label="Memory & routines" disabled={preview} onClick={() => { setRoutineReceipt(null); setShowKnowledge(true); }}><NotebookText size={20} /><span>Memory</span></button>
        <button className="workspace-nav-button" aria-label="Visual workspace" title="Visual workspace (⌘⇧V)" onClick={() => setShowVisuals(true)}><Network size={20} /><span>Visuals</span></button>
        <div className="workspace-rail-bottom"><button className="workspace-nav-button" aria-label="Preferences" title="Preferences" ref={settingsButton} onClick={() => setShowSettings(true)}><Settings2 size={20} /><span>Settings</span></button><span className="workspace-local"><ShieldCheck size={13} />Local</span></div>
      </nav>
      <div className="workspace-main" ref={workspaceMain}>
        <header className="workspace-heading"><div><h1>{page === 'overview' ? 'Your workspace' : 'Your files'}</h1><p>{page === 'overview' ? 'A clear view of everything in motion.' : 'Follow what arrived, and where it went.'}</p></div><button ref={newTaskButton} className="button primary workspace-new-task" disabled={busy} onClick={() => setShowNewTask(true)}><Plus size={16} />New task</button></header>
        <div className={`workspace-grid ${page === 'files' ? 'is-file-view' : ''}`}>
          <div className="workspace-column">
    <section className="command-deck workspace-card" aria-label="Command center">
      <div className="workspace-context"><FolderOpen size={14} /><span>Working in</span><div className="workspace-select"><select aria-label="Current workspace" value={snapshot.currentProjectId || ''} disabled={preview} onChange={event => run(async () => setSnapshot(await bridge!.selectProject(event.target.value || null)))}><option value="">Choose a workspace</option>{snapshot.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select><ChevronDown size={13} /></div><button className="icon-button small-icon" aria-label="Add workspace" title="Add workspace" disabled={preview} onClick={() => run(async () => setSnapshot(await bridge!.addProject()))}><Plus size={14} /></button></div>
      <div className="command-heading workspace-greeting"><h2>{page === 'overview' ? <>Room to think.<br />Space to make progress.</> : 'What are you looking for?'}</h2><p>{page === 'overview' ? 'Your context, your agents, and the next thing to move forward.' : 'Ask a question, find a file, or run a familiar command.'}</p></div>
      <form className={`command-input ${busy ? 'busy' : ''}`} onSubmit={event => { event.preventDefault(); void command(query); }}>
        {busy ? <LoaderCircle className="spinner input-symbol" size={21} /> : <Search className="input-symbol" size={21} strokeWidth={1.7} />}
        <input ref={input} value={query} onChange={event => setQuery(event.target.value)} placeholder="Ask Summon or find a file…" aria-label="Ask Summon or find a file" autoFocus autoComplete="off" spellCheck={false} />
        <kbd className="command-shortcut">⌘ K</kbd>
        <div className="voice-control"><button type="button" className={`icon-button mic-button ${voiceActive ? 'is-listening' : ''}`} disabled={preview || (busy && !voiceActive)} aria-label={voiceActive ? 'Stop listening' : 'Voice options'} aria-expanded={showVoice} onClick={() => voiceActive ? setVoiceMode('off') : setShowVoice(!showVoice)}>{voiceActive ? <Square size={15} fill="currentColor" /> : <Mic size={19} />}</button>
          {showVoice && <div className="voice-menu"><div className="menu-label">VOICE ON THIS MAC</div><button type="button" disabled={!snapshot.health.whisper} onClick={() => setVoiceMode('command')}><Mic size={17} /><span>Speak one command<small>Pause to send · tap stop to cancel</small></span></button><button type="button" disabled={!snapshot.health.whisper || !snapshot.wake?.loaded} onClick={() => setVoiceMode('handsfree')}><Headphones size={17} /><span>Listen for "Summon"<small>Dedicated wake detector · microphone stays on</small></span></button>{!snapshot.health.whisper && <button type="button" onClick={() => { setShowVoice(false); setShowSettings(true); }}><CircleHelp size={17} /><span>Set up local voice<small>Choose a Whisper model first</small></span></button>}{snapshot.speaker?.available && <><div className="menu-label">SPEAKER VERIFICATION</div><button type="button" onClick={startEnrollment}><ShieldCheck size={17} /><span>{snapshot.speaker.enrolled ? 'Re-enroll my voice' : 'Enroll my voice'}<small>10 voice samples · on this Mac</small></span></button></>}</div>}
        </div>
        <button className="submit-command" type="submit" disabled={!query.trim() || busy} aria-label="Run command"><ArrowRight size={19} /></button>
      </form>
      <div className="quick-commands"><button onClick={() => setShowSessions(true)}>What needs me?</button><button onClick={() => setShowWorkInFlight(true)}>Where did I leave off?</button><button onClick={() => { setPage('files'); input.current?.focus(); }}>Find a recent file</button>{voiceActive && <span className="voice-state"><span className={`status-dot ${voice.micActive ? '' : 'paused'}`} />{voiceLabel}</span>}</div>
      {page === 'files' && <div className="workspace-file-tools"><button className="text-button" disabled={preview} onClick={() => run(() => bridge!.openLink('calendar'))}><CalendarDays size={13} />Calendar</button><button className="text-button" onClick={() => void command('find my Excel files')}><FileSpreadsheet size={13} />Recent workbooks</button><button className="text-button" disabled={preview || busy} onClick={() => void command('best coding model')}><Sparkles size={13} />Model rankings</button></div>}
    </section>

    {page === 'overview' && <WorkOverviewCard bridge={bridge} preview={preview} onOpen={() => setShowWorkInFlight(true)} />}
          </div>
          {page === 'overview' && <div className="workspace-column"><SessionsOverviewCard bridge={bridge} preview={preview} onOpen={() => setShowSessions(true)} onView={view => setSessionTotals(view.totals)} /><UsageOverviewCard usage={snapshot.usage} onOpen={() => setShowSettings(true)} /></div>}
        </div>

    {(error || snapshot.health.errors.length > 0) && <div role="alert" className="error-banner"><CircleHelp size={16} /><span>{error || snapshot.health.errors[0]}</span>{snapshot.health.errors.some(message => /Folder access needed|Cannot watch.*E(PERM|ACCES)/.test(message)) && <button className="text-button" onClick={() => run(() => bridge!.openLink('file-access'))}>File access settings<ArrowUpRight size={12} /></button>}{error.includes('Reconnect Claude') && <button className="text-button" onClick={() => run(() => bridge!.openLink('claude-login'))}>Reconnect Claude<ArrowUpRight size={12} /></button>}<button className="text-button" onClick={() => error ? setError('') : setShowSettings(true)}>{error ? 'Dismiss' : 'Preferences'}</button></div>}
    {voice.state === 'error' && <div role="alert" className="error-banner"><MicOff size={16} /><span>{voice.text || 'Voice could not start. Check your microphone permission and local model.'}</span><button className="text-button" onClick={() => setShowSettings(true)}>Voice settings</button></div>}

    <main className="workbench" hidden={page !== 'files'}>
      <section className="ledger" aria-label="File ledger">
        <div className="section-heading"><div><span className="eyebrow">THE PAPER TRAIL</span><h2>{result?.kind === 'files' ? 'Found for you' : 'Recent files'}<span className="count">{filteredFiles.length}</span></h2></div><span className="quiet-label"><History size={13} /> {snapshot.settings.retentionDays} day history</span></div>
        <div className="ledger-tabs" role="group" aria-label="Filter files">{([['all', 'All files'], ['workbooks', 'Workbooks'], ['workspace', 'This workspace']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} className={filter === value ? 'active' : ''} disabled={value === 'workspace' && !currentProject} onClick={() => setFilter(value)}>{label}</button>)}{result && <button className="clear-results" onClick={() => { setResult(null); setAnswer(''); setQuery(''); }} aria-label="Clear results"><X size={13} />Clear</button>}</div>

        {result && <div className={`command-response ${result.kind === 'unknown' ? 'needs-agent' : ''}`} role="status"><div className="response-label">{answerEngine ? `${answerEngine} · CLI answer` : 'SUMMON'}<span>{answerEngine ? (answerReason ? `Auto: ${answerReason}` : 'Requested by you') : result.routineName ? result.routineName : result.kind === 'unknown' ? 'Choose next step' : 'Direct command'}</span></div><p>{result.message}</p>{result.warning && <p className="agent-explainer">{result.warning}</p>}{result.kind === 'unknown' && !answer && <><p className="agent-explainer">Interpret locally to suggest a familiar command for you to review. Or choose an agent for reasoning (Auto picks whichever CLI has the most subscription quota left); this shares your request, selected workspace, current app, up to 20 recent file records, 12 activity entries, and up to 5 matching saved facts or project-note excerpts through the installed CLI. No automatic AI calls.</p><div className="agent-actions"><button className="button small-button" disabled={preview || busy} onClick={() => run(async () => setProposal(await bridge!.interpret(submitted)), true)}>Interpret locally<ShieldCheck size={13} /></button><button className="button small-button" disabled={preview || busy} onClick={() => run(async () => { setAnswerEngine('Claude'); setAnswer((await bridge!.ask('claude', submitted)).text); }, true)}>Ask Claude<ArrowUpRight size={13} /></button><button className="button small-button" disabled={preview || busy} onClick={() => run(async () => { setAnswerEngine('Codex'); setAnswer((await bridge!.ask('codex', submitted)).text); }, true)}>Ask Codex<ArrowUpRight size={13} /></button><button className="button small-button" disabled={preview || busy} title="Whichever CLI has the most of its 5-hour window left" onClick={() => run(async () => { setAnswerEngine('Auto'); setAnswerReason(''); const reply = await bridge!.ask('auto', submitted); setAnswerEngine(reply.engine === 'codex' ? 'Codex' : 'Claude'); setAnswerReason(reply.reason || 'chosen by quota'); setAnswer(reply.text); }, true)}>Ask Auto<ArrowUpRight size={13} /></button><span>Uses your CLI login</span></div></>}{proposal && <div className="local-proposal"><span className="eyebrow">{proposal.model} · ON THIS MAC{proposal.elapsedMs ? ` · ${(proposal.elapsedMs/1000).toFixed(1)}s` : ''}</span><p>{proposal.message}</p>{proposal.kind === 'proposal' && proposal.command && <div><code>{proposal.command}</code><button className="button small-button" disabled={busy} onClick={() => void command(proposal.command!)}>Run this command<ArrowRight size={13}/></button></div>}</div>}{result.routineReceiptId && <button className="text-button save-routine-link" disabled={preview || busy} onClick={() => { setRoutineReceipt(result); setShowKnowledge(true); }}><Plus size={13}/>Save as routine</button>}{answer && <p className="agent-answer">{answer}</p>}{result.kind === 'benchmark' && snapshot.benchmark && <div className="benchmark-results">{snapshot.benchmark.models.slice(0, 5).map((model, index) => <div className="ranking" key={`${model.name}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><strong>{model.name}</strong><span>{model.score === null ? '—' : model.score}</span></div>)}<div className="benchmark-meta"><span>{snapshot.benchmark.fetchedAt ? `Checked ${dateTime(snapshot.benchmark.fetchedAt)}` : 'Not fetched yet'}</span><button className="text-button" disabled={preview} onClick={() => run(() => bridge!.openLink('benchmark'))}>Source<ExternalLink size={12} /></button></div></div>}</div>}

        <div className="file-list" role="group" aria-label="Recent file records">
          {filteredFiles.length === 0 ? <div className="empty-state"><Inbox size={32} strokeWidth={1.2} /><h3>{result?.kind === 'files' ? 'No matching files yet' : filter === 'workspace' ? 'No files in this workspace yet' : filter === 'workbooks' ? 'No workbooks recorded yet' : 'Your next download starts here'}</h3><p>{result?.kind === 'files' ? 'Try part of the filename, "Excel files," or clear the search to browse your ledger.' : 'Summon records incoming files and filing receipts, so you can follow where things went.'}</p>{result?.kind === 'files' ? <button className="button" onClick={() => { setResult(null); setQuery(''); }}>Show all files</button> : !currentProject && <button className="button" disabled={preview} onClick={() => run(async () => setSnapshot(await bridge!.addProject()))}><Plus size={14} />Add a workspace</button>}</div> : filteredFiles.map(file => {
            const project = snapshot.projects.find(item => item.id === file.projectId);
            return <button className={`file-row ${selectedId === file.id ? 'selected' : ''} ${file.status === 'missing' ? 'missing' : ''}`} key={file.id} aria-label={`${file.name}, ${statusText(file)}. ${file.path}`} aria-pressed={selectedId === file.id} onClick={() => setSelectedId(file.id)}><Glyph file={file} /><div className="file-content"><div className="file-title-line"><strong>{file.name}</strong><time dateTime={fileDate(file)} title={dateTime(fileDate(file))}>{shortDate(fileDate(file))}</time></div><div className="file-route"><span className="file-origin" title={file.sourceUrl || file.originalPath}>{source(file)}</span><ArrowRight size={12} /><span className="file-destination" title={file.path}>{folder(file.path)}</span></div><div className="file-meta"><span className={`receipt-status ${file.status}`}><span className="tiny-dot" />{statusText(file)}</span><span className="meta-separator">·</span><span>{project?.name || 'Unassigned'}{file.projectSource === 'inferred' && ' · suggested'}</span><span className="file-size">{size(file.size)}</span></div></div><ArrowUpRight className="row-arrow" size={15} /></button>;
          })}
        </div>
        <footer className="ledger-footer"><ShieldCheck size={13} /><span>Recorded on this Mac</span><span>File content stays in its original app.</span></footer>
      </section>

      <aside className="context-pane" aria-label="File details and activity">
        {selected ? <section className="file-detail"><div className="detail-heading"><span className="eyebrow">FILE RECEIPT</span><button className="icon-button small-icon" onClick={() => setSelectedId(null)} title="Close file details" aria-label="Close file details"><X size={15} /></button></div><div className="detail-identity"><Glyph file={selected} /><div><h3>{selected.name}</h3><p>{selected.extension.replace('.', '').toUpperCase() || 'FILE'}<span>·</span>{size(selected.size)}</p></div></div><div className="detail-actions"><button className="button primary" disabled={preview || selected.status === 'missing' || selected.status === 'unconfirmed'} onClick={() => run(() => bridge!.openFile(selected.id))}><ArrowUpRight size={15} />Open file</button><button className="button" title="Show in Finder" aria-label="Show in Finder" disabled={preview || selected.status === 'missing' || selected.status === 'unconfirmed'} onClick={() => run(() => bridge!.revealFile(selected.id))}><FolderOpen size={16} /></button></div><div className="receipt-path"><span className="path-stop"><ArrowDownToLine size={13} /></span><div><span className="field-label">Arrived from</span><p>{source(selected)}</p><small>First observed · {dateTime(selected.firstSeenAt)}</small></div><span className="path-stop current"><MapPin size={13} /></span><div><span className="field-label">{['missing', 'unconfirmed'].includes(selected.status) ? 'Last known location' : 'Current location'}</span><p className="full-path">{selected.path}</p>{selected.accessIssue && <p>{selected.accessIssue}</p>}{selected.filingAt && <small>Filing receipt · {time(selected.filingAt)}</small>}</div></div><label className="field-label" htmlFor="file-workspace">Workspace</label><div className="detail-select"><Folder size={14} /><select id="file-workspace" disabled={preview} value={selected.projectId || ''} onChange={event => run(async () => setSnapshot(await bridge!.correctFile(selected.id, event.target.value || null)))}><option value="">Unassigned</option>{snapshot.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><ChevronDown size={13} /></div><div className="evidence"><span className="evidence-label">{selected.projectSource === 'inferred' ? <CircleHelp size={13} /> : <Check size={13} />}{selected.projectSource === 'inferred' ? 'Suggested context' : selected.projectSource === 'corrected' ? 'Confirmed by you' : selected.projectSource === 'selected' ? 'From your selection' : 'Context not established'}</span><p>{selected.reason || (selected.projectId ? 'This file is associated with the workspace shown above.' : 'Choose a workspace above to give this file context.')}</p></div></section> : <section className="context-intro"><MapPin size={24} strokeWidth={1.4} /><h3>A place for every trail.</h3><p>Select a file to see its source, current location, and the evidence behind its workspace.</p></section>}

        <section className="activity-section"><div className="detail-heading"><span className="eyebrow">RIGHT NOW</span><span className={`status-dot ${snapshot.settings.paused || !snapshot.settings.activityEnabled || !snapshot.activity || preview ? 'paused' : ''}`} /></div>{snapshot.settings.paused ? <div className="current-activity"><Pause size={17} /><div><strong>Observation paused</strong><p>Your existing records are still available.</p></div></div> : !snapshot.settings.activityEnabled ? <div className="current-activity"><Monitor size={17} /><div><strong>App activity is off</strong><p>Enable it in preferences for working context.</p></div></div> : snapshot.activity ? <><div className="current-activity"><Monitor size={17} /><div><strong>{snapshot.activity.app}</strong><p title={snapshot.activity.title}>{snapshot.activity.title || 'App activity only'}</p></div></div>{snapshot.activity.suggestedProjectId && snapshot.activity.suggestedProjectId !== snapshot.currentProjectId && <button className="suggestion" disabled={preview} onClick={() => run(async () => setSnapshot(await bridge!.selectProject(snapshot.activity!.suggestedProjectId!)))}><span>Working in {snapshot.projects.find(project => project.id === snapshot.activity!.suggestedProjectId)?.name || 'another workspace'}?</span><ArrowRight size={14} /></button>}</> : <div className="current-activity"><Monitor size={17} /><div><strong>{snapshot.health.native ? 'Waiting for app activity' : 'App context unavailable'}</strong><p>{snapshot.health.native ? 'Switch apps to start your activity trail.' : 'The native helper is needed for app activity.'}</p></div></div>}
          <div className="activity-log">{snapshot.events.slice(0, 4).map(event => <button className="activity-event" key={event.id} disabled={!event.fileId} onClick={() => event.fileId && setSelectedId(event.fileId)}><span className="event-dot" /><div><span>{event.title}</span>{event.detail && <small>{event.detail}</small>}</div><time>{time(event.at)}</time></button>)}{snapshot.events.length === 0 && <p className="activity-empty">A short trail of files and context will appear here.</p>}</div>
        </section>
      </aside>
    </main>
    <footer className="app-footer"><span><span className={`status-dot ${preview || snapshot.settings.paused || !snapshot.health.watching ? 'paused' : ''}`} />{preview ? 'Browser preview · native actions disabled' : snapshot.settings.paused ? 'Observation paused' : 'Local activity ledger'}</span><span>{voice.micActive ? <Mic size={12} /> : <MicOff size={12} />}{voiceActive ? voiceLabel : 'Microphone off'}<span className="footer-separator">/</span><button onClick={() => setShowSettings(true)}>Preferences</button></span></footer>
    </div>
    </div>
    {showKnowledge && bridge && <KnowledgePanel snapshot={snapshot} bridge={bridge} receipt={routineReceipt} onClose={() => setShowKnowledge(false)} onSnapshot={setSnapshot} onResult={response => { setPage('files'); setResult(response); setQuery(response.completedCommand||''); setSubmitted(response.completedCommand||''); setAnswer(''); setProposal(null); if(response.fileIds?.length){setSelectedId(response.fileIds[0]);setFilter('all');} }} />}
    {showWorkInFlight && (bridge || preview) && <WorkInFlightPanel bridge={bridge} preview={preview} onClose={() => setShowWorkInFlight(false)} onOpenSessions={() => { setShowWorkInFlight(false); setShowSessions(true); }} />}
    {showSessions && <SessionsPanel bridge={bridge} preview={preview} onClose={() => setShowSessions(false)} onView={view => setSessionTotals(view.totals)} />}
    {showVisuals && <VisualWorkspacePanel bridge={bridge} preview={preview} onClose={() => setShowVisuals(false)} />}
    {showSettings && <Preferences snapshot={snapshot} busy={busy} onClose={() => { setShowSettings(false); settingsButton.current?.focus(); }} onChange={updateSettings} onLink={name => run(() => bridge!.openLink(name))} onChooseModel={() => run(async () => setSnapshot(await bridge!.chooseModel()))} error={error} setVoiceMode={setVoiceMode} voiceActive={handsFreeMode} onEnroll={startEnrollment} onInstallHooks={async () => { const installed = await bridge!.installClaudeHooks(); return installed; }} hookStatus={() => bridge!.claudeHooksStatus()} onRefreshUsage={() => run(async () => { await bridge!.usage({ refresh: true }); setSnapshot(await bridge!.snapshot()); })} onUsageSettings={patch => run(async () => { await bridge!.usageSettings(patch); setSnapshot(await bridge!.snapshot()); })} />}
    {showNewTask && <NewTaskDialog bridge={bridge} projects={snapshot.projects} currentProjectId={snapshot.currentProjectId} onClose={() => { setShowNewTask(false); newTaskButton.current?.focus(); }} onLaunched={(launched, project) => { setPage('files'); setQuery(''); setSubmitted(''); setAnswer(''); setAnswerEngine(''); setAnswerReason(''); setProposal(null); setResult({ kind: 'message', message: `${launched.app === 'claude' ? 'Claude' : 'Codex'} opened in Terminal for ${project.name}${launched.hooks ? '' : ' (without Summon hooks: node was not found)'}.` }); }} />}
    {enrollment && <EnrollmentOverlay enrollment={enrollment} onCancel={cancelEnrollment} onDismiss={dismissEnrollment} />}
  </div>;
}

const fnKeyLabel = (status: NonNullable<Snapshot['fnKey']>['status']) => ({
  ready: 'A plain Fn tap toggles a voice command.',
  starting: 'The Fn shortcut is starting.',
  'permission-required': 'The Fn shortcut needs Input Monitoring for Summon. After an update, remove Summon there and add it again.',
  error: 'The Fn shortcut could not start on this Mac.',
  off: 'The Fn shortcut is off.',
})[status];

function Preferences({ snapshot, busy, onClose, onChange, onLink, onChooseModel, setVoiceMode, voiceActive, error, onEnroll, onInstallHooks, hookStatus, onRefreshUsage, onUsageSettings }: { snapshot: Snapshot; busy: boolean; onClose: () => void; onChange: (patch: SettingsPatch) => Promise<boolean>; onLink: (name: 'calendar' | 'benchmark' | 'accessibility' | 'microphone' | 'input-monitoring' | 'data-folder' | 'file-access') => Promise<unknown>; onChooseModel: () => Promise<unknown>; error: string; setVoiceMode: (mode: VoiceMode) => void; voiceActive: boolean; onEnroll: () => void; onInstallHooks?: () => Promise<{ installed: boolean; backup: string | null; events: string[] }>; hookStatus?: () => Promise<ClaudeHooksStatus>; onRefreshUsage?: () => Promise<unknown>; onUsageSettings?: (patch: Partial<UsageSettings>) => Promise<boolean> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  // Summon hooks in ~/.claude/settings.json: read once when the dialog opens, written only by the button below.
  const [hooks, setHooks] = useState<ClaudeHooksStatus['claude'] | null>(null);
  const [hooksNote, setHooksNote] = useState('');
  const [hooksBusy, setHooksBusy] = useState(false);
  // Once per opening of the dialog: the callbacks are new on every render of the app above, so they are not dependencies here.
  useEffect(() => { if (!hookStatus || preview) return; let alive = true; hookStatus().then(status => { if (alive) setHooks(status.claude); }).catch(() => { if (alive) setHooks(null); }); return () => { alive = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const installHooks = async () => {
    if (!onInstallHooks) return;
    setHooksBusy(true); setHooksNote('');
    try { const done = await onInstallHooks(); setHooksNote(done.backup ? `Backed up to ${done.backup}` : 'Already installed; nothing changed.'); if (hookStatus) setHooks((await hookStatus()).claude); }
    catch (err) { setHooksNote(err instanceof Error ? err.message : String(err)); }
    finally { setHooksBusy(false); }
  };
  const [calendar, setCalendar] = useState(snapshot.settings.calendarUrl);
  const [retention, setRetention] = useState(snapshot.settings.retentionDays);
  const [excluded, setExcluded] = useState(snapshot.settings.excludedApps.join('\n'));
  const [saved, setSaved] = useState(false);
  const [benchmarkKey, setBenchmarkKey] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="preferences-dialog" ref={dialog} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) onClose(); }}><div className="preferences-content"><header className="preferences-heading"><div><span className="eyebrow">MAKE IT YOURS</span><h2>Preferences</h2></div><button className="icon-button" aria-label="Close preferences" onClick={onClose}><X size={20} /></button></header><div className="preferences-scroll">
    {error && <div className="preferences-error" role="alert">{error}</div>}{preview && <div className="preferences-preview">Preview only. Open the installed app to change preferences.</div>}
    <section className="preference-section"><h3><Palette size={16} />Appearance</h3><AccentPicker value={snapshot.settings.accentColor} disabled={busy} onChange={color => onChange({ accentColor: color })} /></section>
    <section className="preference-section"><h3><ActivityIcon size={16} />What Summon notices</h3><div className="preference-row"><div><strong>File access</strong><p>Allow the folders you want Summon to watch in macOS Files and Folders.</p></div><button className="text-button" disabled={preview} onClick={() => void onLink('file-access')}>Open settings<ArrowUpRight size={13} /></button></div><div className="preference-row"><div><strong>App activity</strong><p>Record the active app when you switch between apps.</p></div><Toggle label="App activity" checked={snapshot.settings.activityEnabled} disabled={preview || busy} onChange={value => void onChange({ activityEnabled: value })} /></div><div className="preference-row"><div><strong>Window context</strong><p>Read the focused window title and document path when apps provide them.</p></div><Toggle label="Window context" checked={snapshot.settings.accessibilityEnabled} disabled={preview || busy} onChange={value => void onChange({ accessibilityEnabled: value })} /></div><div className="permission-line"><span className={`permission-state ${snapshot.health.accessibility ? 'granted' : ''}`}>{snapshot.health.accessibility ? <Check size={13} /> : <ShieldCheck size={13} />}{snapshot.health.accessibility ? 'Accessibility granted' : 'Accessibility permission needed for window context'}</span><button className="text-button" disabled={preview} onClick={() => void onLink('accessibility')}>Open settings<ArrowUpRight size={13} /></button></div><p className="preference-note">App changes, file events, window titles and paths. No screen recording or keystroke capture.</p></section>
    <section className="preference-section"><h3><Mic size={16} />Voice, on this Mac</h3><div className="preference-row"><div><strong>Local transcription</strong><p>{snapshot.health.whisper ? 'Whisper is ready for voice commands.' : 'Choose a local Whisper model to enable voice.'}</p></div><span className={`setup-status ${snapshot.health.whisper ? 'ready' : ''}`}>{snapshot.health.whisper ? 'Ready' : 'Setup needed'}</span></div><div className="model-choice"><span title={snapshot.settings.whisperModel}>{snapshot.settings.whisperModel.split('/').pop() || 'No model selected'}</span><button className="button small-button" disabled={preview} onClick={() => void onChooseModel()}>Choose model</button></div><div className="preference-row"><div><strong>Hands-free for this session</strong><p>A small local keyword detector listens for "Summon". Whisper transcribes after it hears the wake word. Keeps the microphone on.</p></div><Toggle label="Hands-free listening" checked={voiceActive} disabled={preview || !snapshot.health.whisper || !snapshot.wake?.loaded} onChange={value => setVoiceMode(value ? 'handsfree' : 'off')} /></div>{snapshot.speaker?.available && <div className="preference-row"><div><strong>Speaker verification</strong><p>{snapshot.speaker.enrolled ? 'Your voice is enrolled. Re-enroll to update your voice profile.' : 'Enroll your voice so Summon verifies commands come from you.'}</p></div><button className="button small-button" disabled={preview} onClick={onEnroll}><ShieldCheck size={13} />{snapshot.speaker.enrolled ? 'Re-enroll' : 'Enroll'}</button></div>}<div className="permission-line"><span className="permission-state"><Keyboard size={13} />Voice can also be started from the command bar.</span><button className="text-button" disabled={preview} onClick={() => void onLink('microphone')}>Microphone settings<ArrowUpRight size={13} /></button></div>{snapshot.fnKey && <div className="permission-line"><span className={`permission-state ${snapshot.fnKey.status === 'ready' ? 'ready' : ''}`}><Keyboard size={13} />{fnKeyLabel(snapshot.fnKey.status)}</span>{snapshot.fnKey.status === 'permission-required' && <button className="text-button" disabled={preview} onClick={() => void onLink('input-monitoring')}>Input Monitoring settings<ArrowUpRight size={13} /></button>}</div>}<p className="preference-note">The menu-bar star lights green while the microphone is on. Listening starts only when you turn it on and is off after every launch. Audio stays on this Mac. The wake detector can miss a phrase or hear a false trigger.</p></section>
    <section className="preference-section"><h3><Bot size={16} />Agents you start</h3><div className="preference-row"><div><strong>Summon hooks for sessions started elsewhere</strong><p>Sessions you start from Summon already report their state. This adds the same hooks to ~/.claude/settings.json so a `claude` you start yourself reports too. Summon backs the file up first and changes nothing else.</p></div><span className={`setup-status ${hooks?.installed ? 'ready' : ''}`}>{hooks?.installed ? 'Installed' : 'Not installed'}</span><button type="button" className="button small-button" disabled={preview || hooksBusy || !onInstallHooks} onClick={() => void installHooks()}>{hooksBusy ? <LoaderCircle size={13} className="spinner" /> : <ShieldCheck size={13} />}{hooks?.installed && !hooks.current ? 'Reinstall Summon hooks' : 'Install Summon hooks'}</button></div>{hooksNote && <p className="preference-note" role="status">{hooksNote}</p>}<p className="preference-note">Codex hooks are reviewed inside Codex itself, so Summon does not install them; Codex sessions started from Summon report when a turn ends.</p></section>
    <section className="preference-section"><h3><Gauge size={16} />Usage</h3>{(['claude', 'codex'] as const).map(provider => { const report = snapshot.usage?.providers[provider] ?? null; return <div className="preference-row" key={provider}><div><strong>{provider === 'claude' ? 'Claude' : 'Codex'}{report?.plan ? ` · ${report.plan}` : ''}</strong><p>{usageWords(report)}</p></div><span className={`setup-status ${report?.status === 'ok' && !report.stale ? 'ready' : ''}`}>{usageChip(report)}</span></div>; })}<div className="permission-line"><span className="permission-state">{snapshot.usage?.refreshing.length ? 'Asking the CLIs…' : usageChecked(snapshot.usage)}</span><button type="button" className="text-button" disabled={preview || !onRefreshUsage || Boolean(snapshot.usage?.refreshing.length)} onClick={() => void onRefreshUsage?.()}>Refresh usage<ArrowUpRight size={13} /></button></div><div className="preference-row"><div><strong>Auto picks by quota</strong><p>Ask Auto, and a connected agent's pick_engine, use the CLI with the most of its 5-hour window left (tie: the 7-day window). A window at or over the ceiling counts as unavailable; with no current reading, your default answers.</p></div></div><div className="model-choice"><label className="wif-engine"><span>Ceiling</span><select value={String(snapshot.usage?.settings.usageCeiling ?? 85)} disabled={preview || !onUsageSettings} onChange={event => void onUsageSettings?.({ usageCeiling: Number(event.target.value) })}>{[60, 70, 75, 80, 85, 90, 95, 100].map(value => <option key={value} value={value}>{value}%</option>)}</select><ChevronDown size={12} /></label><label className="wif-engine"><span>Default</span><select value={snapshot.usage?.settings.defaultEngine ?? 'claude'} disabled={preview || !onUsageSettings} onChange={event => void onUsageSettings?.({ defaultEngine: event.target.value as UsageSettings['defaultEngine'] })}><option value="claude">Claude</option><option value="codex">Codex</option></select><ChevronDown size={12} /></label></div><p className="preference-note">Each number is that CLI reporting on itself: Claude answers one get_usage request on its stream-json input, Codex answers one account/rateLimits/read on its app-server. No prompt is sent, no quota is spent, no thread is started, and Summon never reads a token. Checked every five minutes while Summon runs, and kept in usage.json in the data folder.{snapshot.usage?.problem ? ` ${snapshot.usage.problem}` : ''}</p></section>
    <section className="preference-section"><h3><ShieldCheck size={16}/>Local interpretation</h3><div className="preference-row"><div><strong>{snapshot.localModel?.model||'qwen2.5:3b'}</strong><p>{snapshot.localModel?.error || (snapshot.localModel?.installed ? 'Installed in Ollama. Used only when you choose Interpret locally.' : 'Ollama and this model must be available on this Mac.')}</p></div><span className={`setup-status ${snapshot.localModel?.available && snapshot.localModel?.installed ? 'ready' : ''}`}>{snapshot.localModel?.available && snapshot.localModel?.installed ? 'Available' : 'Unavailable'}</span></div><p className="preference-note">The first request loads the model and can take longer. Suggestions need a click to run; familiar commands and saved routines work without it.</p><div className="preference-row"><div><strong>Dedicated wake detector</strong><p>{snapshot.wake?.error || (snapshot.wake?.loaded ? '"Summon" keyword model loaded. Microphone is separate.' : 'The local wake runtime is not ready.')}</p></div><span className={`setup-status ${snapshot.wake?.loaded ? 'ready' : ''}`}>{snapshot.wake?.loaded ? 'Ready' : 'Unavailable'}</span></div></section>
    <form onSubmit={async event => { event.preventDefault(); setSaved(false); const ok = await onChange({ calendarUrl: calendar.trim(), retentionDays: retention, excludedApps: excluded.split(/[\n,]/).map(item => item.trim()).filter(Boolean), ...(benchmarkKey.trim() ? { benchmarkApiKey: benchmarkKey.trim() } : {}) }); if (ok) { setSaved(true); setBenchmarkKey(''); } }}>
      <section className="preference-section"><h3><CalendarDays size={16} />Your shortcuts</h3><label className="settings-field">Calendar destination<input type="text" value={calendar} disabled={preview} placeholder="Leave empty to open Calendar" onChange={event => { setCalendar(event.target.value); setSaved(false); }} /><span>A calendar website URL, or the Calendar app when empty.</span></label><div className="preference-row"><div><strong>Model rankings</strong><p>AI Stupid Level · fetched only when requested.</p></div><button type="button" className="text-button" disabled={preview} onClick={() => void onLink('benchmark')}>Open source<ArrowUpRight size={13} /></button></div><label className="settings-field">AI Stupid Level API key<input type="password" autoComplete="off" value={benchmarkKey} disabled={preview} placeholder={snapshot.settings.benchmarkKeyConfigured ? 'Key configured · enter a new key to replace it' : 'Paste your API key'} onChange={event => { setBenchmarkKey(event.target.value); setSaved(false); }} /><span>Used for direct rankings requests. The saved key is never sent to this interface.</span></label>{snapshot.settings.benchmarkKeyConfigured !== undefined && <p className="preference-note">{snapshot.settings.benchmarkKeyConfigured ? 'Rankings API is configured on this Mac.' : 'Rankings API key is not configured. The source website is available.'}</p>}</section>
      <section className="preference-section"><h3><History size={16} />Your local record</h3><label className="settings-field retention-field">Keep activity and file records for<div><input type="number" min={1} max={365} required value={retention} disabled={preview} onChange={event => { setRetention(Number(event.target.value)); setSaved(false); }} /><span>days</span></div><span>Removing old records does not remove your files.</span></label><label className="settings-field">Exclude apps<textarea rows={3} disabled={preview} value={excluded} onChange={event => { setExcluded(event.target.value); setSaved(false); }} placeholder={'com.example.private-app'} /><span>Bundle identifiers, one per line. Excluded apps do not contribute activity context.</span></label><div className="data-location"><span>Records stored on this Mac</span><button type="button" className="text-button" disabled={preview} onClick={() => void onLink('data-folder')}>Show data folder<FolderOpen size={13} /></button></div></section>
      <div className="save-preferences"><span role="status">{saved ? <><Check size={14} />Preferences saved</> : 'App and voice switches apply immediately.'}</span><button type="submit" className="button primary" disabled={preview || busy}>{busy ? <LoaderCircle size={14} className="spinner" /> : <Check size={14} />}Save preferences</button></div>
    </form>
  </div></div></dialog>;
}

function EnrollmentOverlay({ enrollment, onCancel, onDismiss }: { enrollment: NonNullable<VoiceStatus['enrollment']>; onCancel: () => void; onDismiss: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => { if (dialog.current?.open) dialog.current.close(); }; }, []);
  const done = enrollment.phase === 'done';
  const phaseText: Record<string, string> = { listening: enrollment.count === 0 ? 'Speak naturally' : 'Keep talking', hearing: 'Hearing you…', captured: `Sample ${enrollment.count} captured`, done: 'Voice enrolled' };
  const phaseHint: Record<string, string> = { listening: enrollment.count === 0 ? 'Say a few sentences at your normal pace. Pause between phrases and the mic will pick up each one.' : 'Pause between phrases. Each pause records a sample.', hearing: 'Keep going — pause when you finish a thought.', captured: 'Keep talking for the next sample.', done: 'Speaker verification is now active.' };
  return <dialog className="enrollment-dialog" ref={dialog} onCancel={event => { event.preventDefault(); done ? onDismiss() : onCancel(); }} onClick={event => { if (event.target === dialog.current && done) onDismiss(); }}>
    <div className="enrollment-content">
      <header className="enrollment-header"><span className="eyebrow">VOICE ENROLLMENT</span><button className="icon-button small-icon" onClick={done ? onDismiss : onCancel} aria-label={done ? 'Close' : 'Cancel enrollment'}><X size={15} /></button></header>
      <div className="enrollment-progress"><div className="enrollment-dots" aria-hidden="true">{Array.from({ length: enrollment.total }, (_, i) => <span key={i} className={`enrollment-dot${i < enrollment.count ? ' filled' : ''}${i === enrollment.count && enrollment.phase === 'hearing' ? ' active' : ''}`} />)}</div><span className="enrollment-count">{enrollment.count} of {enrollment.total} samples</span></div>
      <div className={`enrollment-phase ${enrollment.phase}`}><span className="enrollment-phase-icon">{done || enrollment.phase === 'captured' ? <Check size={16} /> : <Mic size={16} />}</span><div><strong>{phaseText[enrollment.phase]}</strong><p>{phaseHint[enrollment.phase]}</p></div></div>
      <footer className="enrollment-footer">{done ? <button className="button primary" onClick={onDismiss}><Check size={14} />Done</button> : <button className="text-button" onClick={onCancel}>Cancel enrollment</button>}</footer>
    </div>
  </dialog>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
