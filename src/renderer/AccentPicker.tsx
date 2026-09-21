import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, Palette } from 'lucide-react';
import { ACCENT_PRESETS, accentVariables, normalizeAccentColor, parseAccentColor } from './appearance';
import './accent-picker.css';

export type AccentPickerProps = {
  value?: string;
  onChange: (color: string) => unknown | Promise<unknown>;
  compact?: boolean;
  disabled?: boolean;
};

function dismissCustom(panel: HTMLDetailsElement | null, restoreFocus = false) {
  if (!panel) return;
  const focused = document.activeElement;
  const summary = panel.querySelector('summary');
  panel.open = false;
  if (restoreFocus) summary?.focus();
  else if (focused instanceof HTMLElement && focused !== summary && panel.contains(focused)) focused.blur();
}

export function AccentPicker({ value, onChange, compact = false, disabled = false }: AccentPickerProps) {
  const color = normalizeAccentColor(value);
  const [draft, setDraft] = useState(color);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const custom = useRef<HTMLDetailsElement>(null);
  const inputId = useId();
  const errorId = useId();
  const validDraft = parseAccentColor(draft);
  const preset = ACCENT_PRESETS.find(item => item.color === color);
  const blocked = disabled || saving;
  useEffect(() => { setDraft(color); }, [color]);
  useEffect(() => {
    const dismissOutside = (event: Event) => {
      const panel = custom.current;
      if (panel?.open && event.target instanceof Node && !panel.contains(event.target)) dismissCustom(panel);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !custom.current?.open) return;
      event.preventDefault();
      event.stopPropagation();
      dismissCustom(custom.current, true);
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('focusin', dismissOutside, true);
    // Capture Escape before the shell clears its command field or closes a dialog.
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('focusin', dismissOutside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, []);

  const choose = async (next: string) => {
    if (pending.current || disabled) return;
    if (next === color) { dismissCustom(custom.current, custom.current?.open); return; }
    pending.current = true;
    setSaving(true);
    setError('');
    try {
      const saved = await onChange(next);
      if (saved === false) throw new Error('Accent could not be saved. Try again.');
      dismissCustom(custom.current, custom.current?.open);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Accent could not be saved. Try again.');
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  return <div className={`accent-picker${compact ? ' compact' : ''}`} aria-busy={saving}>
    {!compact && <div className="accent-picker-heading"><strong>Accent color</strong><p>Choose a color for buttons, selected items and usage bars.</p></div>}
    <div className="accent-picker-controls" role="group" aria-label="Choose accent color">
      {compact && <span className="accent-picker-label">Accent</span>}
      {ACCENT_PRESETS.map(item => <button key={item.color} type="button" className="accent-swatch" title={`${item.name} accent`} aria-label={`${item.name} accent`} aria-pressed={color === item.color} disabled={blocked} onClick={() => void choose(item.color)}>
        <span style={{ backgroundColor: item.color, color: accentVariables(item.color)['--on-accent'] }}><Check size={11} aria-hidden="true" /></span>
      </button>)}
      <details className="accent-custom" ref={custom} onToggle={event => { if (event.currentTarget.open) { setDraft(color); setError(''); } else dismissCustom(event.currentTarget); }}>
        <summary title="Custom accent color" aria-label="Custom accent color" aria-disabled={blocked} onClick={event => { if (blocked) event.preventDefault(); }}><Palette size={16} aria-hidden="true" /></summary>
        <form className="accent-custom-popover" onSubmit={event => { event.preventDefault(); if (validDraft) void choose(validDraft); }}>
          <label htmlFor={inputId}>Custom accent</label>
          <div className="accent-custom-inputs">
            <input type="color" aria-label="Choose custom accent" value={validDraft ?? color} disabled={blocked} onChange={event => setDraft(event.target.value)} />
            <input id={inputId} type="text" aria-label="Accent hex color" value={draft} maxLength={7} spellCheck={false} autoComplete="off" placeholder="#141615" aria-invalid={!validDraft} aria-describedby={!validDraft ? `${inputId}-hint` : undefined} disabled={blocked} onChange={event => setDraft(event.target.value)} />
          </div>
          <p id={`${inputId}-hint`}>Use a hex color, such as #32664c.</p>
          <button type="submit" className="accent-apply" disabled={blocked || !validDraft}>{saving ? 'Saving…' : 'Apply color'}</button>
        </form>
      </details>
      {!compact && <span className="accent-current">{preset?.name ?? 'Custom'} <span>{color.toUpperCase()}</span></span>}
      <span className="accent-announcement" role="status">{saving ? 'Saving accent color' : `${preset?.name ?? color} accent selected`}</span>
    </div>
    {error && <p id={errorId} className="accent-picker-error" role="alert">{error}</p>}
  </div>;
}
