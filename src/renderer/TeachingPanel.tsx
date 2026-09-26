import React, { useEffect, useRef, useState } from 'react';
import { Check, Circle, Copy, Globe, LoaderCircle, Monitor, MousePointer2, Play, RefreshCw, ShieldCheck, Square, Trash2, X } from 'lucide-react';
import type { Procedure, TeachingBridge, TeachingStep, TeachingView } from './teaching-types';
import './teaching.css';

/* Intent: the person correcting Summon can show one task and inspect what carries
   forward. Hierarchy: the current teaching action leads; saved procedures follow.
   Palette: Summon's paper, ink, pencil, petrol and warning tokens describe the
   notebook, its margin and a live recording. Depth: quiet dividing lines only.
   Surfaces: paper dialog, inset fields, petrol wash for the observed example.
   Typography: system face, 23px title, 14px task, 12px body, 11px provenance.
   Spacing: 4px unit, 16px control groups and 24px between stages. */

type Props = { bridge: TeachingBridge; onClose: () => void };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const scopeText = (procedure: Procedure) => procedure.kind === 'desktop' ? procedure.apps.map(app => app.name).join(' → ') : `${procedure.scope.origin}${procedure.scope.pathname}`;
const onProcedurePage = (procedure: Procedure, url?: string) => {
  if (procedure.kind === 'desktop') return false;
  try { const page = new URL(url || ''); return page.origin === procedure.scope.origin && page.pathname === procedure.scope.pathname; }
  catch { return false; }
};

function stepText(step: TeachingStep) {
  if (step.kind === 'activate') return `Open ${step.surface?.app || 'the demonstrated app'}`;
  const action = { fill: 'Type', click: 'Click', select: 'Select', press: 'Press' }[step.kind];
  const target = step.target?.name || step.target?.placeholder || step.target?.role || step.target?.tag || 'the demonstrated control';
  return `${action}${step.value ? ` “${step.value}”` : ''}${step.kind === 'click' ? ' ' : ' · '}${target}`;
}

function Steps({ procedure }: { procedure: Procedure }) {
  return <ol className="teaching-steps" aria-label="Procedure steps">{procedure.steps.map((step, index) => <li key={index}><span aria-hidden="true">{index + 1}</span><p>{step.surface && step.kind !== 'activate' && <strong className="teaching-step-app">{step.surface.app}</strong>}{stepText(step)}</p></li>)}</ol>;
}

function Provenance({ lastRun }: { lastRun?: TeachingView['lastRun'] }) {
  const verified = lastRun?.verified;
  const confirmed = lastRun?.confirmed;
  return <p className={`teaching-provenance${verified || confirmed ? ' verified' : ''}`}>
    {verified || confirmed ? <Check size={13} aria-hidden="true" /> : <MousePointer2 size={13} aria-hidden="true" />}
    {verified ? 'Latest replay checked against the visible result' : confirmed ? 'Latest result confirmed by you' : 'Learned from your demonstration · reuse not yet verified'}
  </p>;
}

export function TeachingPanel({ bridge, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef<string | null>(null);
  const [view, setView] = useState<TeachingView | null>(null);
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [notice, setNotice] = useState('');
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});

  useEffect(() => {
    mounted.current = true;
    if (!dialog.current?.open) dialog.current?.showModal();
    return () => { mounted.current = false; if (opener.current?.isConnected) opener.current.focus(); };
  }, []);

  useEffect(() => {
    let disposed = false;
    let connect = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const startedAt = generation.current;
      try {
        const next = await (connect ? bridge.teachingAction('connect') : bridge.teachingRead());
        connect = false;
        if (!disposed && mounted.current && startedAt === generation.current) { setView(next); setReadError(''); }
      } catch (problem) {
        if (!disposed && mounted.current && startedAt === generation.current) setReadError(errorText(problem));
      } finally {
        if (!disposed) timer = setTimeout(() => { void poll(); }, 1000);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [bridge]);

  const act = async (action: string, input?: unknown) => {
    // Cancellation remains available while inference or a replay is awaiting its result.
    if (pending.current && action !== 'cancel') return;
    const current = ++generation.current;
    pending.current = action;
    setBusy(action); setError(''); setNotice('');
    if (action === 'finish' || action === 'run' || action === 'attempt') setView(previous => previous ? { ...previous, phase: action === 'finish' ? 'reviewing' : 'running', message: action === 'finish' ? 'Finding the reusable steps in your demonstration…' : action === 'attempt' ? 'Planning the next action in your selected apps…' : 'Following the saved procedure…' } : previous);
    try {
      const next = await bridge.teachingAction(action, input);
      if (mounted.current && generation.current === current) {
        setView(next);
        if (action === 'save') { setIntent(''); setNotice('Procedure saved. Choose new inputs below to try it.'); }
        if (action === 'remove') setNotice('Procedure removed.');
      }
    } catch (problem) {
      if (mounted.current && generation.current === current) setError(errorText(problem));
    } finally {
      // A read started during the action may finish after this newer action result.
      if (generation.current === current) { generation.current++; pending.current = null; if (mounted.current) setBusy(null); }
    }
  };

  const copyConnection = async () => {
    if (!view?.connection) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(view.connection));
      if (mounted.current) setNotice('Connection copied. Paste it into the Summon browser extension.');
    } catch {
      if (mounted.current) setError('Clipboard unavailable. Select and copy the connection text below.');
    }
  };

  const desktopMode = (view?.mode ?? 'desktop') === 'desktop';
  const desktop = view?.desktop;
  const engine = desktop?.engine ?? 'codex';
  const engineName = engine === 'local' ? 'the local model' : engine === 'claude' ? 'Claude' : 'Codex';
  const visualReady = !desktop?.visualReading || Boolean(desktop.permissions.screenRecording);
  const permissionReady = Boolean(desktop?.permissions.accessibility && desktop?.permissions.inputMonitoring);
  const selectedApps = desktop?.selectedApps ?? [];
  const availableApps = desktop?.apps ?? [];
  const recording = view?.phase === 'recording';
  const working = view?.phase === 'reviewing' || view?.phase === 'running';
  const locked = Boolean(busy || recording || working || view?.phase === 'proposal');
  const active = view?.procedures.find(procedure => procedure.id === view.activeId) ?? null;
  const lastRun = active && view?.lastRun?.id === active.id ? view.lastRun : null;
  const matchingPage = active ? onProcedurePage(active, view?.browser.url) : false;
  const canStart = desktopMode ? permissionReady && selectedApps.length > 0 : Boolean(view?.browser.connected);
  const canAttempt = Boolean(desktop?.permissions.accessibility && selectedApps.length > 0 && visualReady);
  const canRun = active?.kind === 'desktop' ? Boolean(desktop?.permissions.accessibility && visualReady) : Boolean(view?.browser.connected && matchingPage);
  const missingPermissions = [!desktop?.permissions.accessibility && 'Accessibility', !desktop?.permissions.inputMonitoring && 'Input Monitoring'].filter(Boolean).join(' and ');
  const toggleApp = (bundleId: string, checked: boolean) => { void act('apps', { bundleIds: checked ? [...selectedApps, bundleId] : selectedApps.filter(id => id !== bundleId) }); };
  const activeValues = active ? Object.fromEntries(active.parameters.map(parameter => [parameter.name, values[active.id]?.[parameter.name] ?? parameter.example])) : {};
  const connectionJSON = view?.connection ? JSON.stringify(view.connection) : '';

  return <dialog ref={dialog} className="preferences-dialog teaching-dialog" aria-labelledby="teaching-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <div className="preferences-content">
      <header className="preferences-heading"><div><span className="eyebrow">SHOW IT ONCE, CHANGE THE INPUT</span><h2 id="teaching-title">Teach Summon</h2></div><button className="icon-button" type="button" aria-label="Close teaching" onClick={onClose}><X size={20} /></button></header>
      <div className="preferences-scroll teaching-scroll">
        {(error || readError) && <p className="preferences-error" role="alert">{error || readError}</p>}
        {notice && <p className="teaching-notice" role="status"><Check size={14} aria-hidden="true" />{notice}</p>}
        {!view ? <p className="teaching-loading" role="status"><LoaderCircle size={15} className="spinner" aria-hidden="true" />Connecting to Summon…</p> : <>
          <div className="teaching-modes" role="group" aria-label="Teaching environment">
            <button type="button" aria-pressed={desktopMode} disabled={locked} onClick={() => { void act('mode', { mode: 'desktop' }); }}><Monitor size={15} aria-hidden="true" />Mac apps</button>
            <button type="button" aria-pressed={!desktopMode} disabled={locked} onClick={() => { void act('mode', { mode: 'browser' }); }}><Globe size={15} aria-hidden="true" />Browser tab</button>
          </div>
          {desktopMode ? <section className="teaching-connection" aria-label="Mac app scope">
            <div className="teaching-browser"><Monitor size={17} aria-hidden="true" /><div><strong>Choose where to teach</strong><p>Include each app your demonstration will use.</p></div></div>
            <div className={`teaching-permissions${permissionReady ? ' ready' : ''}`}>
              <ShieldCheck size={16} aria-hidden="true" /><div><strong>{permissionReady ? 'Desktop permissions ready' : `${missingPermissions} needed`}</strong><p>{permissionReady ? 'Recording starts only when you start a demonstration.' : 'Allow these permissions in macOS, then refresh to check them.'}</p></div>
              {!permissionReady && <button className="button" type="button" disabled={locked} onClick={() => { void act('permissions'); }}>Enable desktop teaching</button>}
            </div>
            <div className="teaching-app-heading"><span>Apps to include</span><button className="text-button" type="button" disabled={locked} onClick={() => { void act('refresh-apps'); }}><RefreshCw size={12} aria-hidden="true" />Refresh apps and permissions</button></div>
            <fieldset className="teaching-apps" disabled={locked}><legend className="sr-only">Apps to include in the demonstration</legend>
              {availableApps.map(app => <label key={app.bundleId} className="teaching-app"><input type="checkbox" aria-label={app.name} checked={selectedApps.includes(app.bundleId)} onChange={event => toggleApp(app.bundleId, event.target.checked)} /><span>{app.name}</span></label>)}
            </fieldset>
            {!availableApps.length && <p className="teaching-caption">Open the apps you want to use, then refresh this list.</p>}
            <p className="teaching-caption">Only the apps you select are recorded during a demonstration. Summon uses controls exposed by macOS; an app without accessible controls may not support teaching.</p>
            <div className="teaching-reasoning">
              <label className="settings-field">Reasoning<select aria-label="Desktop reasoning" value={engine} disabled={locked} onChange={event => { void act('engine', { engine: event.target.value }); }}><option value="codex">Codex · existing sign-in</option><option value="claude">Claude · existing sign-in</option><option value="local">Local · stays on this Mac</option></select></label>
              <p className="teaching-caption">{engine === 'local' ? 'Uses the configured Ollama model on this Mac. Stops if unavailable; never switches to a cloud model.' : `${engineName} receives the task and selected-app text through your signed-in CLI. Uses your plan limits; no API key or separate API bill.`} This choice is saved.</p>
              <label className="teaching-app teaching-visual-option"><input type="checkbox" aria-label="Read screen text locally" checked={Boolean(desktop?.visualReading)} disabled={locked} onChange={event => { void act('visual-reading', { enabled: event.target.checked }); }} /><span>Read screen text locally</span></label>
              <p className="teaching-caption">Read text missing from app accessibility during Try task and reuse. Window images stay in memory on this Mac; extracted text goes to {engineName}. Enabled for this session only.</p>
              {desktop?.visualReading && desktop.visualMessage && desktop.visualStatus !== 'off' && <p className="teaching-caption" role="status">{desktop.visualMessage}</p>}
              {desktop?.visualReading && !desktop.permissions.screenRecording && <div className="teaching-permissions"><ShieldCheck size={16} aria-hidden="true" /><div><strong>Screen Recording needed</strong><p>Allow Summon to read the selected app’s front window, then refresh permissions.</p></div><button className="button" type="button" disabled={locked} onClick={() => { void act('screen-permission'); }}>Allow screen reading</button></div>}
            </div>
          </section> : <section className="teaching-connection" aria-label="Browser connection">
            <div className="teaching-browser"><Globe size={17} aria-hidden="true" /><div><strong>{view.browser.connected ? 'Browser connected' : 'Connect a Chrome tab'}</strong><p title={view.browser.url}>{view.browser.connected ? view.browser.title || view.browser.url || 'Ready for your demonstration' : 'Choose the tab where you want to teach a task.'}</p></div><span className={`teaching-connection-dot${view.browser.connected ? ' connected' : ''}`} aria-hidden="true" /></div>
            <details className="teaching-setup"><summary>{view.browser.connected ? 'Connection settings' : 'Set up the browser extension'}</summary>
              {bridge.showTeachingExtension && <button className="button" type="button" onClick={() => { void bridge.showTeachingExtension!().catch(problem => setError(errorText(problem))); }}>Show extension folder</button>}
              <ol><li>Open Chrome’s Extensions page and enable Developer mode.</li><li>Choose <strong>Load unpacked</strong> and select <code>integrations/browser-teaching</code> in the Summon project.</li><li>Open the Summon extension on the tab you want to use. Paste this connection, then connect the tab.</li></ol>
              {view.connection ? <><button className="button" type="button" onClick={() => { void copyConnection(); }}><Copy size={13} aria-hidden="true" />Copy connection</button><label className="settings-field teaching-connection-value">Connection text<textarea aria-label="Connection text" readOnly rows={2} value={connectionJSON} onFocus={event => event.target.select()} spellCheck={false} /></label></> : <p className="teaching-caption">The local browser connection is starting. Keep Summon open.</p>}
            </details>
          </section>}

          <section className="preference-section teaching-stage" aria-label="Teach a task">
            {recording ? <>
              <div className="teaching-stage-title"><Circle size={15} className="teaching-recording-dot" aria-hidden="true" /><h3>Show me how</h3></div>
              <p className="teaching-lead">{desktopMode ? 'Go to your selected apps and do the task once.' : 'Go to the connected tab and do the task once.'}</p>
              <p className="teaching-copy">Type into the fields and click the results as you normally would. Finish here when you see the result you wanted.</p>
              <p className="teaching-status" role="status">{view.message || (desktopMode ? 'Watching your demonstration in the selected apps.' : 'Watching your demonstration in the connected tab.')}</p>
              <div className="teaching-actions"><button className="button primary" type="button" disabled={Boolean(busy)} onClick={() => { void act('finish'); }}><Square size={12} aria-hidden="true" />Finish demonstration</button><button className="text-button" type="button" disabled={busy === 'cancel'} onClick={() => { void act('cancel'); }}>Cancel demonstration</button></div>
              <p className="teaching-caption">You can close this panel while you demonstrate. Recording continues until you finish or cancel.</p>
            </> : working ? <>
              <div className="teaching-stage-title"><LoaderCircle size={17} className="spinner" aria-hidden="true" /><h3>{view.phase === 'reviewing' ? 'Learning the procedure' : 'Working on your task'}</h3></div>
              <p className="teaching-copy" role="status">{view.message}</p>
              <div className="teaching-actions"><button className="button" type="button" disabled={busy === 'cancel'} onClick={() => { void act('cancel'); }}>{busy === 'cancel' ? 'Stopping…' : 'Stop'}</button></div>
              <p className="teaching-caption">Closing this panel keeps the task running. Use Stop to cancel it.</p>
            </> : view.phase === 'proposal' && view.proposal ? <>
              <span className="eyebrow">LEARNED PROCEDURE</span><h3 className="teaching-proposal-title">{view.proposal.name}</h3>
              <p className="teaching-copy">{view.proposal.summary}</p>
              {view.proposal.parameters.length > 0 && <div className="teaching-variables"><p>What can change next time</p><dl>{view.proposal.parameters.map(parameter => <div key={parameter.name}><dt>{parameter.label || parameter.name}{parameter.primary && <span>Spoken input</span>}</dt><dd>{parameter.example}</dd></div>)}</dl></div>}
              <Steps procedure={view.proposal} /><Provenance />
              {view.proposal.verification && <p className="teaching-caption">Success check: the visible result newly shows “{view.proposal.verification.text}”.</p>}
              <p className="teaching-caption">For {scopeText(view.proposal)}</p>
              <div className="teaching-actions"><button className="button primary" type="button" disabled={Boolean(busy)} onClick={() => { void act('save'); }}><Check size={14} aria-hidden="true" />Save procedure</button><button className="text-button" type="button" disabled={Boolean(busy)} onClick={() => { void act('cancel'); }}>Discard</button></div>
            </> : <>
              <h3>{desktopMode ? 'A task to try or teach' : 'A task you can show'}</h3><p className="teaching-copy">{desktopMode ? 'Ask Summon to try, or show it how. Saved demonstrations guide future attempts.' : 'Demonstrate with one example. Summon looks for the steps it can reuse when you name a different input.'}</p>
              <form onSubmit={event => { event.preventDefault(); void act('start', { intent: intent.trim() }); }}><label className="settings-field">{desktopMode ? 'What should Summon do?' : 'What should Summon learn?'}<textarea aria-label={desktopMode ? 'What should Summon do?' : 'What should Summon learn?'} value={intent} onChange={event => setIntent(event.target.value)} rows={3} maxLength={2000} placeholder="Search for the item I name and open its details." required /></label><div className="teaching-actions">{desktopMode && <button className="button primary" type="button" disabled={Boolean(busy) || !canAttempt || !intent.trim()} onClick={() => { void act('attempt', { intent: intent.trim() }); }}><Play size={14} aria-hidden="true" />Try task</button>}<button className={`button${desktopMode ? '' : ' primary'}`} disabled={Boolean(busy) || !canStart || !intent.trim()}><MousePointer2 size={14} aria-hidden="true" />Start demonstration</button></div></form>
              {view.message && <p className={view.phase === 'error' ? 'preferences-error' : 'teaching-status'} role={view.phase === 'error' ? 'alert' : 'status'}>{view.message}</p>}
              <p className="teaching-caption">{desktopMode ? `Recording starts only when you ask. ${engine === 'local' ? 'Demonstrated interactions and selected-app text are processed on this Mac.' : `Demonstrated interactions and selected-app text are sent to ${engineName} through your CLI sign-in.`} Each task step uses current app controls. Screen reading adds text context; it cannot click controls the app does not expose.` : 'Recording starts only when you ask. When you finish, Summon sends your demonstrated interactions and recorded page text to Codex through your CLI sign-in to learn the procedure.'}</p>
            </>}
          </section>

          <section className="preference-section teaching-saved" aria-label="Saved procedures"><div className="teaching-saved-heading"><h3>Ready to reuse</h3><span>{view.procedures.length}</span></div>
            {view.procedures.length ? <>
              <label className="settings-field">Active procedure<select aria-label="Active procedure" value={view.activeId || ''} disabled={locked} onChange={event => { void act('select', { id: event.target.value || null }); }}><option value="">Voice reuse off · choose a procedure</option>{view.procedures.map(procedure => <option value={procedure.id} key={procedure.id}>{procedure.name}</option>)}</select></label>
              {active && <article className="teaching-procedure"><p className="teaching-copy">{active.summary}</p><p className="teaching-caption teaching-scope">{scopeText(active)}</p><Provenance lastRun={lastRun} />
                {lastRun && !lastRun.verified && !lastRun.confirmed && <div className="teaching-confirm"><p>{active.kind === 'desktop' ? 'Check the apps. Did the task finish as you intended?' : 'Check the connected tab. Did the task finish as you intended?'}</p><button className="button" type="button" disabled={locked} onClick={() => { void act('confirm'); }}><Check size={13} aria-hidden="true" />Looks right</button></div>}
                <form onSubmit={event => { event.preventDefault(); void act('run', { id: active.id, values: activeValues }); }}><div className="teaching-inputs">{active.parameters.map(parameter => <label className="settings-field" key={parameter.name}>{parameter.label || parameter.name}<input aria-label={parameter.label || parameter.name} value={activeValues[parameter.name] ?? ''} disabled={locked} maxLength={500} onChange={event => { const value = event.target.value; setValues(previous => ({ ...previous, [active.id]: { ...previous[active.id], [parameter.name]: value } })); }} required />{parameter.primary && <span>The name you can say when this procedure is active.</span>}</label>)}</div><div className="teaching-actions"><button className="button primary" disabled={locked || !canRun || Object.values(activeValues).some(value => !value.trim())}><Play size={13} aria-hidden="true" />{active.kind === 'desktop' ? 'Run in saved apps' : 'Run on connected tab'}</button><button className="text-button teaching-remove" type="button" disabled={locked} onClick={() => { void act('remove', { id: active.id }); }}><Trash2 size={13} aria-hidden="true" />Remove</button></div></form>
                {active.kind !== 'desktop' && view.browser.connected && !matchingPage && <p className="teaching-caption">Connect the page where this procedure was taught to run it again.</p>}
                {active.kind === 'desktop' && !desktop?.permissions.accessibility && <p className="teaching-caption">Enable Accessibility to run this procedure in its saved apps.</p>}
                <details className="teaching-details"><summary>View saved steps</summary><Steps procedure={active} /></details>
              </article>}
            </> : <p className="teaching-copy teaching-empty">Your saved procedures will appear here with the inputs you can change and the steps Summon learned.</p>}
          </section>
        </>}
      </div>
    </div>
  </dialog>;
}
