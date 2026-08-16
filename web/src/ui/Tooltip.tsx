import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import styles from './tooltip.module.css';

/**
 * Names an icon-only control.
 *
 * Two attributes rather than one, because `title` was doing both jobs: the tip everyone
 * sees and the name assistive tech reads. Dropping it for a styled tooltip would have
 * quietly left every icon button unnamed.
 */
export function tip(text: string): { 'data-tip': string; 'aria-label': string } {
  return { 'data-tip': text, 'aria-label': text };
}

interface Shown {
  text: string;
  x: number;
  y: number;
}

const DELAY_MS = 400;
const GAP = 7;
const MARGIN = 8;

/**
 * One layer for the whole app, driven by `data-tip` on whatever the pointer is over. A
 * component per tooltip would mean a listener and a timer on every icon button in the shell.
 */
export function TooltipLayer() {
  const [shown, setShown] = useState<Shown | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timer.current);
      setShown(null);
    };

    const reveal = (host: HTMLElement, delay: number) => {
      const text = host.dataset.tip;
      if (!text) return;

      window.clearTimeout(timer.current);

      timer.current = window.setTimeout(() => {
        const rect = host.getBoundingClientRect();

        setShown({ text, x: rect.left + rect.width / 2, y: rect.bottom + GAP });
      }, delay);
    };

    const onOver = (event: MouseEvent) => {
      const host = (event.target as Element | null)?.closest?.<HTMLElement>('[data-tip]');

      if (!host) {
        hide();
        return;
      }

      reveal(host, DELAY_MS);
    };

    // Keyboard focus shows it at once: someone tabbing has already asked for this control.
    const onFocus = (event: FocusEvent) => {
      const host = (event.target as Element | null)?.closest?.<HTMLElement>('[data-tip]');

      if (host) reveal(host, 0);
      else hide();
    };

    document.addEventListener('mouseover', onOver);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('mousedown', hide);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);

    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('mousedown', hide);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // The width is only known once the text is in the DOM, so the nudge back inside the
  // viewport happens after the first paint of each tip rather than when it is positioned.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;

    const rect = element.getBoundingClientRect();
    const overflowRight = rect.right - (window.innerWidth - MARGIN);
    const overflowLeft = MARGIN - rect.left;

    if (overflowRight > 0) element.style.marginLeft = `${-overflowRight}px`;
    else if (overflowLeft > 0) element.style.marginLeft = `${overflowLeft}px`;
    else element.style.marginLeft = '';
  }, [shown]);

  if (!shown) return null;

  return (
    <div ref={box} className={styles.tip} style={{ left: shown.x, top: shown.y }} role="tooltip">
      {shown.text}
    </div>
  );
}
