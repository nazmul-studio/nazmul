import { cleanup, render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Typed } from './typed';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Typed accessibility and motion', () => {
  it('exposes the complete text once while the visual text is typing', () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    render(<Typed as="h1" text="Architect of immersive web & engineered systems." />);
    expect(screen.getByRole('heading', { name: 'Architect of immersive web & engineered systems.' })).toBeInTheDocument();
  });

  it('shows complete text immediately when reduced motion is requested', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const { container } = render(<Typed text="Precision in thought." />);
    expect(container.querySelector('.typed-visual')?.textContent).toBe('Precision in thought.');
  });

  it('disconnects the observer and stops the timer on unmount', () => {
    vi.useFakeTimers();
    const disconnect = vi.fn();
    let intersect: IntersectionObserverCallback | undefined;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { intersect = callback; }
      observe() {} disconnect = disconnect;
    });
    const { unmount } = render(<Typed text="Wonder in creation." speed={28} />);
    act(() => intersect?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(disconnect).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});