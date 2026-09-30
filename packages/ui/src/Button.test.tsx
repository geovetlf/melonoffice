import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './Button.js';

afterEach(cleanup);

describe('Button', () => {
  it('renders a native button that defaults to type="button" and the primary variant', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toBe('mo-button mo-button--primary');
  });

  it('applies the secondary variant and extra classes', () => {
    render(
      <Button variant="secondary" className="extra">
        Cancel
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toBe(
      'mo-button mo-button--secondary extra',
    );
  });

  it('forwards events and ARIA attributes', () => {
    const onClick = vi.fn();
    render(
      <Button aria-pressed="true" onClick={onClick}>
        English
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'English', pressed: true });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('shows it is busy while loading, and waits', () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Saving
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Saving' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.querySelector('.mo-spinner')?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('takes the quiet and destructive variants, the small size and an icon-only shape', () => {
    render(
      <>
        <Button variant="ghost" size="sm">
          More
        </Button>
        <Button variant="danger" iconOnly aria-label="Remove" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'More' }).className).toBe(
      'mo-button mo-button--ghost mo-button--sm',
    );
    expect(screen.getByRole('button', { name: 'Remove' }).className).toBe(
      'mo-button mo-button--danger mo-button--icon',
    );
  });
});
