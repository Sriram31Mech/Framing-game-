// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NUDGE_EVENT, useGuideLock } from '../src/features/tour/guideLock';

afterEach(() => cleanup());

function Harness({ allow, onClick }: { allow: string[] | null; onClick: (id: string) => void }) {
  useGuideLock(allow);
  return (
    <div>
      <button data-testid="target" onClick={() => onClick('target')}>
        Target
      </button>
      <button data-testid="other" onClick={() => onClick('other')}>
        Other
      </button>
      <div data-guide-allow>
        <button data-testid="card" onClick={() => onClick('card')}>
          Card
        </button>
      </div>
      <div aria-modal="true">
        <button data-testid="modal" onClick={() => onClick('modal')}>
          Modal
        </button>
      </div>
    </div>
  );
}

describe('useGuideLock', () => {
  it('lets only the target, the guide card and modals through, and nudges on the rest', () => {
    const onClick = vi.fn();
    const nudge = vi.fn();
    window.addEventListener(NUDGE_EVENT, nudge);
    render(<Harness allow={['[data-testid="target"]']} onClick={onClick} />);

    for (const id of ['target', 'other', 'card', 'modal']) {
      fireEvent.pointerDown(screen.getByTestId(id));
      fireEvent.click(screen.getByTestId(id));
    }
    expect(onClick.mock.calls.map((c) => c[0])).toEqual(['target', 'card', 'modal']);
    expect(nudge).toHaveBeenCalledTimes(1);
    window.removeEventListener(NUDGE_EVENT, nudge);
  });

  it('blocks keys outside the allowed area but never Tab', () => {
    const onKey = vi.fn();
    window.addEventListener('keydown', onKey);
    render(<Harness allow={[]} onClick={() => {}} />);
    fireEvent.keyDown(screen.getByTestId('other'), { key: 'Escape' });
    fireEvent.keyDown(screen.getByTestId('other'), { key: 'Tab' });
    fireEvent.keyDown(screen.getByTestId('card'), { key: 'Enter' });
    expect(onKey.mock.calls.map((c) => (c[0] as KeyboardEvent).key)).toEqual(['Tab', 'Enter']);
    window.removeEventListener('keydown', onKey);
  });

  it('does nothing when there is no lock', () => {
    const onClick = vi.fn();
    render(<Harness allow={null} onClick={onClick} />);
    fireEvent.click(screen.getByTestId('other'));
    expect(onClick).toHaveBeenCalledWith('other');
  });
});
