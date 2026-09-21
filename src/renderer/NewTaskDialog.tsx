import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Bot, LoaderCircle, X } from 'lucide-react';
import type { AgentLaunchResult, Project, SummonBridge } from './types';

/* A deliberate launch, in the same quiet paper dialog as Preferences.
   Workspace and engine stay explicit before opening Terminal. */
export function NewTaskDialog({ bridge, projects, currentProjectId, onClose, onLaunched }: {
  bridge?: SummonBridge;
  projects: Project[];
  currentProjectId: string | null;
  onClose: () => void;
  onLaunched: (result: AgentLaunchResult, project: Project) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [projectId, setProjectId] = useState(currentProjectId || projects[0]?.id || '');
  const [engine, setEngine] = useState<'codex' | 'claude'>('codex');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const launch = async (event: React.FormEvent) => {
    event.preventDefault();
    const project = projects.find(value => value.id === projectId);
    if (!bridge || !project || pending.current) return;
    pending.current = true;
    setBusy(true); setError('');
    try {
      const result = await bridge.launchAgent({ app: engine, projectId });
      onLaunched(result, project);
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className="new-task-dialog" aria-labelledby="new-task-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => { if (event.target === dialog.current && !busy) { const box = dialog.current.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose(); } }}>
    <form onSubmit={event => void launch(event)}>
      <header className="workspace-dialog-heading"><div><span className="eyebrow">MAKE ROOM FOR THE NEXT THING</span><h2 id="new-task-title">Start a new task</h2></div><button type="button" className="icon-button" aria-label="Close new task" disabled={busy} onClick={onClose}><X size={19} /></button></header>
      <div className="workspace-launch-options">
        <label className="settings-field">Workspace<select autoFocus value={projectId} onChange={event => setProjectId(event.target.value)} disabled={busy || !projects.length}>{!projects.length && <option value="">Add a workspace first</option>}{projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
        <label className="settings-field">Agent<select value={engine} onChange={event => setEngine(event.target.value as 'codex' | 'claude')} disabled={busy}><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
      </div>
      <p className="preference-note">Opens the selected CLI in Terminal, using its existing sign-in and Summon’s session hooks. Enter your task there once it opens.</p>
      {!bridge && <p className="preferences-preview">Native launches are available in the installed app.</p>}
      {error && <p role="alert" className="preferences-error">{error}</p>}
      <footer className="workspace-dialog-footer"><button type="button" className="text-button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="button primary" disabled={!bridge || !projectId || busy}>{busy ? <LoaderCircle size={15} className="spinner" /> : <Bot size={15} />}Start {engine === 'claude' ? 'Claude' : 'Codex'}<ArrowUpRight size={14} /></button></footer>
    </form>
  </dialog>;
}
