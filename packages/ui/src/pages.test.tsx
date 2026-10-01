import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTable } from './DataTable.js';
import { FormSection } from './FormSection.js';
import { ListItem } from './ListItem.js';
import { PageHeader } from './PageHeader.js';
import { PeriodPicker } from './PeriodPicker.js';
import { Toolbar } from './Toolbar.js';

afterEach(cleanup);

describe('PageHeader', () => {
  it('holds the page’s one h1, its line and its actions', () => {
    render(
      <PageHeader
        title="Agents"
        titleId="agents-title"
        eyebrow="Settings"
        description="Who works in the office."
        actions={<button type="button">Create</button>}
      />,
    );
    const heading = screen.getByRole('heading', { level: 1, name: 'Agents' });
    expect(heading.id).toBe('agents-title');
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    const header = heading.closest('header') as HTMLElement;
    expect(within(header).getByText('Who works in the office.').tagName).toBe('P');
    expect(within(header).getByRole('button', { name: 'Create' })).toBeTruthy();
  });

  it('draws no empty action area', () => {
    const { container } = render(<PageHeader title="Reports" actions={false} />);
    expect(container.querySelector('.mo-page-header__actions')).toBeNull();
  });
});

describe('PeriodPicker', () => {
  it('says which option is chosen and emits the one pressed', () => {
    const onChange = vi.fn();
    render(
      <PeriodPicker
        label="Period"
        options={['today', 'week', 'month'] as const}
        value="week"
        onChange={onChange}
        renderOption={(o) => o.toUpperCase()}
      />,
    );
    const group = screen.getByRole('group', { name: 'Period' });
    expect(group.className).toBe('mo-segmented');
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    fireEvent.click(screen.getByRole('button', { name: 'MONTH' }));
    expect(onChange).toHaveBeenCalledWith('month');
  });
});

describe('DataTable', () => {
  it('is a named table in a box that scrolls on its own', () => {
    render(
      <DataTable label="By capability">
        <thead>
          <tr>
            <th scope="col">Capability</th>
            <th scope="col" className="mo-table__num">
              Credits
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Text</td>
            <td className="mo-table__num">3</td>
          </tr>
        </tbody>
      </DataTable>,
    );
    const table = screen.getByRole('table', { name: 'By capability' });
    expect(table.className).toBe('mo-table');
    expect(table.parentElement?.className).toBe('mo-table-scroll');
    // Nothing overflows here, so the box is no extra tab stop.
    expect(table.parentElement?.hasAttribute('tabindex')).toBe(false);
    // And it is never a landmark of its own.
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('while it scrolls, is a named group the keyboard reaches, never a landmark', () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    const width = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(800);
    const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    render(
      <DataTable label="By model">
        <tbody>
          <tr>
            <td>gemini</td>
          </tr>
        </tbody>
      </DataTable>,
    );
    const box = screen.getByRole('group', { name: 'By model' });
    expect(box.getAttribute('tabindex')).toBe('0');
    expect(screen.queryByRole('region')).toBeNull();
    width.mockRestore();
    client.mockRestore();
    vi.unstubAllGlobals();
  });

  it('shows a caption instead of a hidden name', () => {
    render(
      <DataTable caption="Customers">
        <tbody>
          <tr>
            <td>Acme</td>
          </tr>
        </tbody>
      </DataTable>,
    );
    expect(screen.getByRole('table', { name: 'Customers' }).hasAttribute('aria-label')).toBe(false);
  });
});

describe('ListItem', () => {
  it('is a list entry with its title, facts, badges and actions', () => {
    render(
      <ul className="mo-list">
        <ListItem
          title="menu.docx"
          titleAs="h3"
          meta="4 KB"
          badges={<span>Stored</span>}
          actions={<button type="button">Delete</button>}
        />
      </ul>,
    );
    const item = screen.getByRole('listitem');
    expect(item.className).toBe('mo-list-item');
    expect(within(item).getByRole('heading', { level: 3, name: 'menu.docx' })).toBeTruthy();
    expect(within(item).getByText('4 KB').className).toBe('mo-list-item__meta');
    expect(within(item).getByRole('button', { name: 'Delete' })).toBeTruthy();
  });
});

describe('FormSection', () => {
  it('is a region named by its title', () => {
    render(
      <FormSection title="Your business" description="What GIA knows.">
        <input aria-label="Name" />
      </FormSection>,
    );
    const region = screen.getByRole('region', { name: 'Your business' });
    expect(within(region).getByRole('heading', { level: 2 })).toBeTruthy();
    expect(within(region).getByRole('textbox', { name: 'Name' })).toBeTruthy();
  });
});

describe('Toolbar', () => {
  it('is a named group only when it has a name', () => {
    const { rerender } = render(
      <Toolbar>
        <span>x</span>
      </Toolbar>,
    );
    expect(screen.queryByRole('group')).toBeNull();
    rerender(
      <Toolbar label="Filters">
        <span>x</span>
      </Toolbar>,
    );
    expect(screen.getByRole('group', { name: 'Filters' }).className).toBe('mo-toolbar');
  });
});
