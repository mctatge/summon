import React, { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import './fullscreen.css';

/** Keep the view mounted: expanding must not reset its filters, draft or camera. */
export function FullscreenButton({ target, label }: { target: React.RefObject<HTMLElement | null>; label: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const owned = useRef<HTMLElement | null>(null);
  const request = useRef(0);
  const recentlyExited = useRef(0);
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const view = target.current;
    if (!view) return;
    const enclosingDialog = view.closest('dialog');
    const cancelTarget = enclosingDialog ?? view;
    let mounted = true;
    const restore = () => {
      if (!owned.current || document.fullscreenElement === owned.current) return;
      owned.current = null;
      view.classList.remove('view-fullscreen');
      recentlyExited.current = Date.now();
      if (mounted) { setActive(false); setPending(false); button.current?.focus({ preventScroll: true }); }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !owned.current) return;
      // A detail dialog opened above the work tree retains its own close action.
      const modal = (event.target as Element | null)?.closest?.('dialog[open]');
      if (modal && modal !== enclosingDialog) return;
      event.preventDefault(); event.stopImmediatePropagation();
      void document.exitFullscreen().catch(() => {});
    };
    const cancel = (event: Event) => {
      if (event.target !== cancelTarget || (!owned.current && Date.now() - recentlyExited.current > 350)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (owned.current && document.fullscreenElement === owned.current) void document.exitFullscreen().catch(() => {});
    };
    document.addEventListener('fullscreenchange', restore);
    document.addEventListener('keydown', escape, true);
    cancelTarget.addEventListener('cancel', cancel, true);
    return () => {
      mounted = false; request.current++;
      document.removeEventListener('fullscreenchange', restore);
      document.removeEventListener('keydown', escape, true);
      cancelTarget.removeEventListener('cancel', cancel, true);
      view.classList.remove('view-fullscreen');
      if (owned.current && document.fullscreenElement === owned.current) void document.exitFullscreen().catch(() => {});
      owned.current = null;
    };
  }, [target]);

  const toggle = async () => {
    if (pending || !target.current) return;
    const generation = ++request.current;
    const exiting = Boolean(owned.current && document.fullscreenElement === owned.current);
    setError(''); setPending(true);
    try {
      if (exiting) {
        await document.exitFullscreen();
      } else {
        const view = target.current;
        // A dialog itself cannot use the Fullscreen API; its content can.
        const surface = view instanceof HTMLDialogElement ? view.firstElementChild as HTMLElement | null : view;
        if (!surface?.requestFullscreen) throw new Error('Full screen is not available in this window.');
        owned.current = surface;
        view.classList.add('view-fullscreen');
        await surface.requestFullscreen();
        if (generation !== request.current) {
          if (document.fullscreenElement === surface) await document.exitFullscreen();
          return;
        }
        setActive(document.fullscreenElement === surface);
      }
    } catch {
      if (generation !== request.current) return;
      const stillActive = Boolean(owned.current && document.fullscreenElement === owned.current);
      if (!stillActive) {
        owned.current = null;
        target.current?.classList.remove('view-fullscreen');
      }
      setActive(stillActive);
      setError(exiting ? 'Could not exit full screen. Press Esc to return.' : 'Could not enter full screen. Try again after reopening Summon.');
    } finally { if (generation === request.current) setPending(false); }
  };

  const action = active ? `Exit full screen for ${label}` : `Full screen for ${label}`;
  return <span className="view-fullscreen-control"><button ref={button} type="button" className="icon-button" disabled={pending} aria-label={action} title={active ? 'Exit full screen (Esc)' : 'Full screen'} aria-pressed={active} onClick={() => { void toggle(); }}>{active ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>{error && <span className="view-fullscreen-error" role="alert">{error}</span>}</span>;
}
