import { useEffect } from 'react';

/** Keep keyboard focus in the current dialog and return it to its opener. */
export function useModalFocus(key: string) {
  useEffect(() => {
    if (!key) return;
    const dialog = document.querySelector<HTMLElement>('.modal-backdrop [role="dialog"]');
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'))
      .filter((element) => element.getClientRects().length > 0);
    if (!dialog.contains(document.activeElement)) (dialog.querySelector<HTMLInputElement>('input:not([readonly])') || controls()[0])?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = controls();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected && !dialog.contains(opener)) opener.focus();
    };
  }, [key]);
}
