// @vitest-environment jsdom
import { createOatClient, type OatRequest, type OatResponse } from '@oat/client';
import { localDay } from '@oat/editor/task-dates';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FeatureUiProvider, type FeatureUiAdapter, type LinkComponent } from './provider';
import type { TaskItemDto } from './task-helpers';
import { useTaskAssignees } from './tasks-client';
import { TasksView, TasksViewSkeleton, type TaskFilters } from './tasks-view';

const filters: TaskFilters = { view: 'assigned', status: 'open', due: 'any' };
const item = (id = 't1', documentId = 'd1'): TaskItemDto => ({
  id,
  blockId: `block-${id}`,
  text: `Do ${id}`,
  done: false,
  due: localDay(),
  owner: { name: 'Alex Park', email: 'alex@example.test', userId: 'u', isMe: true },
  document: {
    id: documentId,
    title: `Note ${documentId}`,
    kind: 'meeting',
    version: 3,
    date: '2026-11-21T00:00:00Z',
    canEdit: true,
  },
});
const json = (data: unknown, status = 200): OatResponse => ({ status, json: async () => data });
function setup(
  handler: (request: OatRequest) => Promise<OatResponse> = async () =>
    json({ items: [item()], truncated: false }),
) {
  const transport = vi.fn(handler);
  const value: FeatureUiAdapter = {
    client: createOatClient(transport),
    transport,
    navigate: vi.fn(),
    hrefFor: (target) =>
      target.kind === 'document'
        ? `/d/${target.id}${target.blockId ? `?block=${target.blockId}` : ''}`
        : '/',
    notify: { success: vi.fn(), error: vi.fn() },
    workspaceId: 'w',
    user: { id: 'u', name: 'Alex', email: 'alex@example.test' },
    searchSources: [],
  };
  function Wrapper({ children }: { children: ReactNode }) {
    return <FeatureUiProvider value={value}>{children}</FeatureUiProvider>;
  }
  return { transport, value, wrapper: Wrapper };
}

describe('TasksView', () => {
  it('renders grouped tasks, owner and due badges, truncation and block links through the host Link', async () => {
    const env = setup(async () =>
      json({ items: [item(), item('t2'), item('t3', 'd2')], truncated: true }),
    );
    const Link: LinkComponent = (props) => <a {...props} data-host-link />;
    env.value.Link = Link;
    render(<TasksView value={filters} onChange={vi.fn()} />, env);
    expect(await screen.findAllByTestId('task-row')).toHaveLength(3);
    expect(screen.getAllByTestId('task-group')).toHaveLength(2);
    expect(screen.getAllByTestId('task-owner')[0]?.textContent).toContain('You');
    const avatar = screen.getAllByTestId('task-owner')[0]?.querySelector('[data-slot="avatar"]');
    expect(avatar?.getAttribute('aria-hidden')).toBe('true');
    expect(avatar?.querySelector('[data-slot="avatar-fallback"]')?.textContent).toBe('AP');
    expect(screen.getAllByTestId('task-due')[0]?.textContent).toContain('Today');
    const link = screen.getByRole('link', { name: 'Do t1' });
    expect(link.getAttribute('href')).toBe('/d/d1?block=block-t1');
    expect(link.hasAttribute('data-host-link')).toBe(true);
    expect(screen.getByTestId('tasks-truncated')).toBeTruthy();
    expect(env.transport).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/tasks',
        query: expect.objectContaining({ ...filters, workspaceId: 'w', today: localDay() }),
      }),
    );
  });

  it('reports controlled filter changes and refetches only when the host updates value', async () => {
    const env = setup();
    const onChange = vi.fn();
    const { rerender } = render(<TasksView value={filters} onChange={onChange} />, env);
    await screen.findByText('Do t1');
    await userEvent.click(screen.getByRole('tab', { name: 'Created by me' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, view: 'created' });
    expect(env.transport).toHaveBeenCalledTimes(1);
    rerender(<TasksView value={{ ...filters, view: 'created' }} onChange={onChange} />);
    await waitFor(() => expect(env.transport).toHaveBeenCalledTimes(2));
    expect(env.transport).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ view: 'created' }) }),
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Status' }));
    await userEvent.click(screen.getByRole('option', { name: 'Done' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, view: 'created', status: 'done' });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Status' })),
    );
    act(() => screen.getByRole('combobox', { name: 'Due date' }).focus());
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.click(await screen.findByRole('option', { name: 'Overdue' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, view: 'created', due: 'overdue' });
  });

  it('optimistically checks off and rolls back failed updates with a host toast', async () => {
    let finish!: (response: OatResponse) => void;
    const env = setup(async (request) =>
      request.method === 'PATCH'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : json({ items: [item()], truncated: false }),
    );
    render(<TasksView value={filters} onChange={vi.fn()} />, env);
    const checkbox = await screen.findByRole('checkbox', { name: 'Mark “Do t1” as done' });
    await userEvent.click(checkbox);
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
    expect(checkbox.hasAttribute('data-disabled')).toBe(true);
    await act(async () =>
      finish(json({ error: { code: 'forbidden', message: 'Read only' } }, 403)),
    );
    await waitFor(() => expect(checkbox.getAttribute('aria-checked')).toBe('false'));
    expect(env.value.notify.error).toHaveBeenCalledWith('Couldn’t update the task', {
      description: 'Read only',
    });
    expect(env.transport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'PATCH',
        path: '/api/tasks/t1',
        body: { done: true, baseVersion: 3 },
      }),
    );
  });

  it('retries one stale-version update and uses its new version for later ticks', async () => {
    let writes = 0;
    const env = setup(async (request) => {
      if (request.method !== 'PATCH') return json({ items: [item()], truncated: false });
      writes++;
      return writes === 1
        ? json(
            { error: { code: 'stale_version', message: 'Changed' }, document: { version: 7 } },
            409,
          )
        : json({ id: 't1', done: true, documentVersion: 8 });
    });
    render(<TasksView value={filters} onChange={vi.fn()} />, env);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Mark “Do t1” as done' }));
    await waitFor(() => expect(writes).toBe(2));
    await waitFor(() =>
      expect(screen.getByRole('checkbox').hasAttribute('data-disabled')).toBe(false),
    );
    expect(env.transport).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: { done: true, baseVersion: 7 } }),
    );
    await userEvent.click(screen.getByRole('checkbox'));
    expect(env.transport).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: { done: false, baseVersion: 8 } }),
    );
  });

  it('preserves two concurrent optimistic checkoffs', async () => {
    const finishes: Array<(response: OatResponse) => void> = [];
    const env = setup(async (request) =>
      request.method === 'PATCH'
        ? new Promise((resolve) => finishes.push(resolve))
        : json({ items: [item(), item('t2', 'd2')], truncated: false }),
    );
    render(<TasksView value={filters} onChange={vi.fn()} />, env);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Mark “Do t1” as done' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mark “Do t2” as done' }));
    await act(async () => finishes[0]?.(json({ id: 't1', done: true, documentVersion: 4 })));
    expect(screen.getAllByRole('checkbox').map((box) => box.getAttribute('aria-checked'))).toEqual([
      'true',
      'true',
    ]);
    await act(async () => finishes[1]?.(json({ id: 't2', done: true, documentVersion: 4 })));
  });

  it('aborts list requests on filter change and unmount and ignores late answers', async () => {
    const env = setup(() => new Promise(() => {}));
    const { rerender, unmount } = render(<TasksView value={filters} onChange={vi.fn()} />, env);
    const first = env.transport.mock.calls[0]?.[0].signal;
    rerender(<TasksView value={{ ...filters, status: 'done' }} onChange={vi.fn()} />);
    expect(first?.aborted).toBe(true);
    const second = env.transport.mock.calls[1]?.[0].signal;
    unmount();
    expect(second?.aborted).toBe(true);
  });

  it('retains the current list during filter refetches', async () => {
    const env = setup(async (request) =>
      request.query?.status === 'done'
        ? new Promise(() => {})
        : json({ items: [item()], truncated: false }),
    );
    const { rerender } = render(<TasksView value={filters} onChange={vi.fn()} />, env);
    await screen.findByText('Do t1');
    rerender(<TasksView value={{ ...filters, status: 'done' }} onChange={vi.fn()} />);
    expect(screen.getByText('Do t1')).toBeTruthy();
    expect(screen.getByTestId('tasks-list').getAttribute('aria-busy')).toBe('true');
  });

  it.each([
    [filters, 'Nothing assigned to you'],
    [{ ...filters, view: 'created' as const }, 'No action items in your notes'],
    [{ ...filters, view: 'all' as const }, 'No action items yet'],
    [{ ...filters, status: 'done' as const }, 'Nothing done yet'],
    [{ ...filters, due: 'overdue' as const }, 'Nothing overdue'],
  ])('keeps the empty state for %j', async (value, title) => {
    render(
      <TasksView value={value} onChange={vi.fn()} />,
      setup(async () => json({ items: [], truncated: false })),
    );
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.getByTestId('tasks-empty').className).toContain('border-dashed');
    expect(screen.getByRole('heading', { name: title }).tagName).toBe('H2');
  });

  it('offers retry after a list error', async () => {
    let calls = 0;
    render(
      <TasksView value={filters} onChange={vi.fn()} />,
      setup(async () =>
        ++calls === 1
          ? json({ error: { code: 'unavailable', message: 'Try later' } }, 503)
          : json({ items: [item()], truncated: false }),
      ),
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Do t1')).toBeTruthy();
  });

  it('keeps read-only tasks disabled and supports native block navigation without hrefs', async () => {
    const row = item();
    row.document.canEdit = false;
    const env = setup(async () => json({ items: [row], truncated: false }));
    delete env.value.hrefFor;
    render(<TasksView value={filters} onChange={vi.fn()} />, env);
    expect((await screen.findByRole('checkbox')).hasAttribute('data-disabled')).toBe(true);
    await userEvent.click(screen.getByRole('link', { name: 'Do t1' }));
    expect(env.value.navigate).toHaveBeenCalledWith({
      kind: 'document',
      id: 'd1',
      blockId: 'block-t1',
    });
  });

  it('uses identical toolbar, section and row classes in the loading skeleton', async () => {
    const { container, unmount } = render(<TasksViewSkeleton />);
    const toolbar = container.querySelector('[role=tablist]')?.parentElement?.className;
    const row = container.querySelector('li')?.className;
    const rowContent = container.querySelector('li [data-slot="item"]')?.className;
    const section = container.querySelector('section')?.className;
    expect(screen.getByRole('combobox', { name: 'Status' }).hasAttribute('disabled')).toBe(true);
    unmount();
    render(<TasksView value={filters} onChange={vi.fn()} />, setup());
    const task = await screen.findByTestId('task-row');
    expect(task.closest('li')?.className).toBe(row);
    expect(task.className).toBe(rowContent);
    expect(task.closest('section')?.className).toBe(section);
    expect(screen.getByRole('tablist').parentElement?.className).toBe(toolbar);
  });
});

describe('useTaskAssignees', () => {
  it('supplies the editor picker from the typed client and preserves empty/error fallback', async () => {
    const people = [{ name: 'Alex', email: 'alex@example.test', userId: 'u' }];
    const env = setup(async (request) =>
      request.query?.q === 'fail'
        ? json({}, 500)
        : json({ people: request.query?.q === 'nobody' ? [] : people }),
    );
    const { result } = renderHook(() => useTaskAssignees('d1'), env);
    await expect(result.current('Al')).resolves.toEqual(people);
    expect(env.transport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: '/api/tasks/assignees',
        query: { documentId: 'd1', q: 'Al' },
      }),
    );
    await expect(result.current('nobody')).resolves.toEqual([]);
    await expect(result.current('fail')).resolves.toEqual([]);
  });

  it('aborts picker requests on unmount', async () => {
    const env = setup(() => new Promise(() => {}));
    const { result, unmount } = renderHook(() => useTaskAssignees('d1'), env);
    void result.current('Al');
    const signal = env.transport.mock.calls[0]?.[0].signal;
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
