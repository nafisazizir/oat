// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { Participant, TranscriptItem } from './format.ts';
import { ParticipantChips } from './participants.tsx';
import { SidePanel } from './side-panel.tsx';
import { TranscriptList } from './transcript-list.tsx';
import { NoteColumn, TRANSCRIPT_PANEL_SIZE } from './note-column.tsx';

// jsdom has no layout: give the scroller a size so the virtualizer renders rows.
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 400 });

const lines: TranscriptItem[] = [
  { id: 's1', source: 'system', startMs: 0, endMs: 1000, text: 'Hello from them' },
  { id: 's2', source: 'mic', startMs: 2000, endMs: 3000, text: 'Hi, me here' },
  { id: 's3', source: 'mic', startMs: 3500, endMs: 4000, text: 'still typing', isFinal: false },
];

describe('shared note geometry', () => {
  it('keeps the web measure and permits caller spacing and attributes', () => {
    render(
      <NoteColumn className="gap-6" data-testid="note-column">
        Notes
      </NoteColumn>,
    );
    const column = screen.getByTestId('note-column');
    expect(column.className).toContain('max-w-content');
    expect(column.className).toContain('sm:py-14');
    expect(column.className).toContain('gap-6');
    expect(column.className).not.toContain('gap-10');
    expect(TRANSCRIPT_PANEL_SIZE).toEqual({ default: 360, min: 280, max: 600 });
  });
});

describe('TranscriptList', () => {
  it('renders me/them lines with speaker headers, interims marked', () => {
    render(<TranscriptList segments={lines} />);
    const rows = screen.getAllByTestId('transcript-segment');
    expect(rows.map((r) => r.dataset.source)).toEqual(['system', 'mic', 'mic']);
    expect(rows.map((r) => r.dataset.final)).toEqual(['true', 'true', 'false']);
    expect(screen.getByText('Them')).toBeTruthy();
    // One "Me" header for two consecutive mic lines.
    expect(screen.getAllByText('Me')).toHaveLength(1);
    for (const text of ['Hello from them', 'Hi, me here', 'still typing']) {
      const bubble = screen.getByText(text);
      expect(bubble.className).toContain('rounded-lg');
      expect(bubble.className).toContain('bg-gray-100');
      expect(bubble.className).not.toContain('blue-');
    }
  });

  it('marks the focused line and reports selections (click and keyboard)', async () => {
    const onSelect = vi.fn();
    render(<TranscriptList segments={lines} focusId="s2" onSelect={onSelect} />);
    const focused = screen
      .getAllByTestId('transcript-segment')
      .filter((r) => r.dataset.focused !== undefined);
    expect(focused.map((r) => r.dataset.segmentId)).toEqual(['s2']);
    const button = screen.getByRole('button', { name: /^Them at 0:00: Hello from them$/ });
    await userEvent.click(button);
    expect(onSelect).toHaveBeenLastCalledWith(lines[0]);
    fireEvent.keyDown(screen.getByRole('button', { name: /^Me at 0:02/ }), { key: 'Enter' });
    expect(onSelect).toHaveBeenLastCalledWith(lines[1]);
  });

  it('highlights the line under the playhead, distinct from the focused one', () => {
    render(<TranscriptList segments={lines} activeId="s1" focusId="s2" onSelect={() => {}} />);
    const rows = screen.getAllByTestId('transcript-segment');
    expect(
      rows.filter((r) => r.dataset.active !== undefined).map((r) => r.dataset.segmentId),
    ).toEqual(['s1']);
    expect(rows[0]!.getAttribute('aria-current')).toBe('time');
    expect(rows[1]!.getAttribute('aria-current')).toBe('true');
  });

  it('stops following the playhead when the user scrolls, offers the way back, re-arms on a seek', async () => {
    function Harness() {
      const [active, setActive] = useState('s1');
      const [key, setKey] = useState(0);
      return (
        <>
          <button onClick={() => setActive('s2')}>advance</button>
          <button onClick={() => setKey((k) => k + 1)}>seek</button>
          <TranscriptList segments={lines} activeId={active} playheadKey={key} />
        </>
      );
    }
    render(<Harness />);
    expect(screen.queryByTestId('back-to-playhead')).toBeNull();
    fireEvent.wheel(screen.getByTestId('transcript-scroll'));
    expect(await screen.findByTestId('back-to-playhead')).toBeTruthy();
    await userEvent.click(screen.getByText('advance'));
    expect(screen.getByTestId('back-to-playhead')).toBeTruthy(); // the highlight moving doesn't re-arm
    await userEvent.click(screen.getByText('seek'));
    await waitFor(() => expect(screen.queryByTestId('back-to-playhead')).toBeNull());
    fireEvent.wheel(screen.getByTestId('transcript-scroll'));
    await userEvent.click(await screen.findByTestId('back-to-playhead'));
    expect(screen.queryByTestId('back-to-playhead')).toBeNull();
  });

  it('a just-recorded note played back: the playhead wins over the live end', async () => {
    const many: TranscriptItem[] = Array.from({ length: 300 }, (_, i) => ({
      id: `l${i}`,
      source: i % 2 ? 'system' : 'mic',
      startMs: i * 3000,
      endMs: i * 3000 + 2500,
      text: `line ${i}`,
    }));
    const { rerender } = render(
      <TranscriptList segments={many} follow activeId="l150" playheadKey={1} />,
    );
    const scroller = screen.getByTestId('transcript-scroll');
    // The reveal scroll (ours) and a new segment arriving never show "Jump to live" or pull to the end.
    fireEvent.scroll(scroller);
    rerender(
      <TranscriptList
        segments={[...many, { id: 'new', source: 'mic', startMs: 999_000, text: 'late' }]}
        follow
        activeId="l150"
        playheadKey={1}
      />,
    );
    fireEvent.scroll(scroller);
    expect(screen.queryByTestId('jump-to-live')).toBeNull();
    expect(screen.queryByTestId('back-to-playhead')).toBeNull();
    // A press on the list's padding (no scrollbar there) is not the user scrolling.
    fireEvent.pointerDown(scroller);
    expect(screen.queryByTestId('back-to-playhead')).toBeNull();
    // The user scrolls by hand: "Back to playback", still no "Jump to live".
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    expect(await screen.findByTestId('back-to-playhead')).toBeTruthy();
    expect(screen.queryByTestId('jump-to-live')).toBeNull();
  });

  it('has no clickable lines without onSelect', () => {
    render(<TranscriptList segments={lines} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('ParticipantChips', () => {
  const people: Participant[] = [
    { id: 'p1', name: 'Ada Lovelace', email: 'ada@example.com', source: 'calendar' },
    { id: 'p2', name: 'Grace Hopper', email: null, source: 'manual' },
  ];

  it('shows chips; read-only has no controls', () => {
    render(<ParticipantChips participants={people} editable={false} />);
    expect(screen.getAllByTestId('participant-chip').map((c) => c.textContent)).toEqual([
      'ALAda Lovelace',
      'GHGrace Hopper',
    ]);
    expect(screen.getByLabelText('From the calendar')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('read-only and empty says so', () => {
    render(<ParticipantChips participants={[]} editable={false} />);
    expect(screen.getByText('No attendees')).toBeTruthy();
  });

  it('adds (validated) and removes', async () => {
    const onAdd = vi.fn(async () => {});
    const onRemove = vi.fn(async () => {});
    render(<ParticipantChips participants={people} editable onAdd={onAdd} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Grace Hopper' }));
    expect(onRemove).toHaveBeenCalledWith(people[1]);

    await userEvent.click(screen.getByTestId('add-participant'));
    await userEvent.type(screen.getByLabelText('Email (optional)'), 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('That email doesn’t look right.')).toBeTruthy();
    expect(onAdd).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText('Email (optional)'));
    await userEvent.type(screen.getByLabelText('Email (optional)'), 'lin@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    // No name: the email stands in.
    expect(onAdd).toHaveBeenCalledWith({ name: 'lin@example.com', email: 'lin@example.com' });
    await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull());
  });

  it('removes optimistically and puts the chip back when the caller rejects', async () => {
    let reject!: (error: Error) => void;
    const onRemove = vi.fn(() => new Promise<void>((_, r) => (reject = r)));
    render(<ParticipantChips participants={people} editable onRemove={onRemove} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Grace Hopper' }));
    // Gone before the caller answers.
    expect(screen.getAllByTestId('participant-chip')).toHaveLength(1);
    expect(screen.getByTestId('participants').dataset.count).toBe('1');

    reject(new Error('Network down'));
    expect(await screen.findByText('Network down')).toBeTruthy();
    expect(screen.getAllByTestId('participant-chip')).toHaveLength(2);
  });

  it('shows the error the caller rejects with', async () => {
    const onAdd = vi.fn(async () => {
      throw new Error('You can’t edit this note.');
    });
    render(<ParticipantChips participants={[]} editable onAdd={onAdd} />);
    await userEvent.click(screen.getByTestId('add-participant'));
    await userEvent.type(screen.getByLabelText('Name'), 'Lin');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('You can’t edit this note.')).toBeTruthy();
  });
});

describe('SidePanel', () => {
  function Harness() {
    const [open, setOpen] = useState(true);
    return open ? (
      <SidePanel
        title="Transcript"
        closeLabel="Hide transcript"
        onClose={() => setOpen(false)}
        storageKey="test.panel.width"
        defaultWidth={320}
        minWidth={240}
        maxWidth={480}
        data-testid="panel"
      >
        <p>body</p>
      </SidePanel>
    ) : (
      <p>closed</p>
    );
  }

  it('resizes with the keyboard within bounds, remembers it, and closes', async () => {
    window.localStorage.clear();
    const { unmount } = render(<Harness />);
    const panel = screen.getByTestId('panel');
    expect(panel.dataset.width).toBe('320');
    const handle = screen.getByRole('separator', { name: 'Resize panel' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(panel.dataset.width).toBe('336');
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(panel.dataset.width).toBe('480');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(panel.dataset.width).toBe('480');
    fireEvent.keyDown(handle, { key: 'End' });
    expect(handle.getAttribute('aria-valuenow')).toBe('240');
    expect(window.localStorage.getItem('test.panel.width')).toBe('240');
    unmount();

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('panel').dataset.width).toBe('240'));
    await userEvent.click(screen.getByRole('button', { name: 'Hide transcript' }));
    expect(screen.getByText('closed')).toBeTruthy();
  });
});
