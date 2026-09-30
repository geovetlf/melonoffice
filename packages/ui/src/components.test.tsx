import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Avatar, initialsOf } from './Avatar.js';
import { Badge } from './Badge.js';
import { StateMessage } from './StateMessage.js';
import { StatusDot } from './StatusDot.js';

afterEach(cleanup);

describe('Badge', () => {
  it('takes a tone, an outline or a count', () => {
    render(
      <>
        <Badge>Draft</Badge>
        <Badge tone="warning">Proposed</Badge>
        <Badge outline>Soon</Badge>
        <Badge count>3</Badge>
      </>,
    );
    expect(screen.getByText('Draft').className).toBe('mo-badge');
    expect(screen.getByText('Proposed').className).toBe('mo-badge mo-badge--warning');
    expect(screen.getByText('Soon').className).toBe('mo-badge mo-badge--outline');
    expect(screen.getByText('3').className).toBe('mo-badge mo-badge--count');
  });
});

describe('StatusDot', () => {
  it('is decoration beside the words, or an image with its own label', () => {
    const { container } = render(<StatusDot state="attention" />);
    expect(container.firstElementChild?.className).toBe('mo-dot mo-dot--attention');
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    render(<StatusDot state="working" label="Working" />);
    expect(screen.getByRole('img', { name: 'Working' }).className).toBe('mo-dot mo-dot--working');
  });
});

describe('StateMessage', () => {
  it('announces an error at once and every other state politely', () => {
    render(
      <>
        <StateMessage kind="error" title="The list did not load">
          Try again in a moment.
        </StateMessage>
        <StateMessage kind="empty">Nothing here yet.</StateMessage>
        <StateMessage kind="loading">Loading…</StateMessage>
      </>,
    );
    expect(screen.getByRole('alert').textContent).toContain('The list did not load');
    const polite = screen.getAllByRole('status');
    expect(polite.map((el) => el.className)).toEqual([
      'mo-state mo-state--empty',
      'mo-state mo-state--loading',
    ]);
    expect(polite[1]?.querySelector('.mo-spinner')).not.toBeNull();
  });
});

describe('Avatar', () => {
  it('shows the first letters of the first two words', () => {
    expect(initialsOf('ana ventas lópez')).toBe('AV');
    expect(initialsOf('  GIA ')).toBe('G');
    const { container } = render(<Avatar name="Leo Campañas" size="sm" />);
    expect(container.textContent).toBe('LC');
    expect(container.firstElementChild?.className).toBe('mo-avatar mo-avatar--sm');
  });
});
