// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../src/ui/Dialog';

afterEach(() => cleanup());

describe('ConfirmDialog', () => {
  it('explains costs and risks before confirming', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="Buy parcel HV-001?"
        description="2.00 ha of laterite soil."
        lines={[
          { label: 'Purchase price', value: '₹2,00,000.00' },
          { label: 'Land tax (per 30-day month)', value: '₹300.00' },
          { label: 'Cash after purchase', value: '₹50,000.00', total: true },
        ]}
        warnings={['This leaves less than 3 months of obligations.']}
        confirmLabel="Buy for ₹2 L"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const dialog = screen.getByTestId('confirm-dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(screen.getByText('Purchase price')).toBeTruthy();
    expect(screen.getByText('₹2,00,000.00')).toBeTruthy();
    expect(screen.getByText('Cash after purchase')).toBeTruthy();
    expect(screen.getByText(/less than 3 months/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('confirm-ok'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows server errors inline and blocks dismissal while busy', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="Buy?"
        lines={[]}
        confirmLabel="Buy"
        busy
        error={{ title: 'Someone got there first', message: 'Reloaded.' }}
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Someone got there first');
    fireEvent.keyDown(screen.getByTestId('confirm-dialog'), { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
    expect((screen.getByTestId('confirm-ok') as HTMLButtonElement).disabled).toBe(true);
  });
});
