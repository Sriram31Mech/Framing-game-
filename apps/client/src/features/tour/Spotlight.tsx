/**
 * Pulsing ring + bouncing arrow around the first visible element matching `selectors`; with
 * `dim` the rest of the screen darkens (input is locked separately by guideLock).
 * Polls because targets live in panels and 3D labels that open, close and move.
 */
import { useEffect, useState } from 'react';

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

function find(selectors: string[]): Box | null {
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0)
        return { top: r.top, left: r.left, width: r.width, height: r.height };
    }
  }
  return null;
}

export function Spotlight({ selectors, dim }: { selectors: string[]; dim?: boolean }) {
  const [box, setBox] = useState<Box | null>(null);
  // A modal (crop picker, confirmation) must stay readable, so never dim over one.
  const [modal, setModal] = useState(false);
  const key = selectors.join('|');

  useEffect(() => {
    const list = key ? key.split('|') : [];
    const tick = () => {
      setModal(!!document.querySelector('[aria-modal="true"]'));
      const next = list.length ? find(list) : null;
      setBox((prev) =>
        prev &&
        next &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.width === next.width &&
        prev.height === next.height
          ? prev
          : next,
      );
    };
    tick();
    const id = setInterval(tick, 150);
    return () => clearInterval(id);
  }, [key]);

  if (!box) return null;
  const pad = 6;
  const rect = {
    top: box.top - pad,
    left: box.left - pad,
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  };
  // Two layers: the dim sits under Thatha's card, the brackets and pointer above everything.
  return (
    <>
      {dim && !modal ? <div className="tour-dim" aria-hidden="true" style={rect} /> : null}
      <div className="tour-spot" aria-hidden="true" style={rect}>
        <span className={`tour-arrow${box.top < 70 ? ' below' : ''}`} />
      </div>
    </>
  );
}
