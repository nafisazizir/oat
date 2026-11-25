'use client';

import {
  MeetingAccess,
  MeetingMetaRow,
  type MeetingMetaLook,
  MeetingPrivate,
  MeetingTime,
  NoteColumn,
  ParticipantSummary,
  type Participant,
} from '@oat/meeting-ui';
import { Button } from '@oat/ui/components/button';
import { ToggleGroup, ToggleGroupItem } from '@oat/ui/components/toggle-group';
import { IconSparkles } from '@tabler/icons-react';
import { useState } from 'react';

import { MeetingEventLineView } from '@/components/calendar/meeting-event-line-view';
import { useHydrated } from '@/lib/use-hydrated';

const NAMES = [
  'Ana Lee',
  'Ben Ito',
  'Cy Park',
  'Di Wu',
  'Eve Ng',
  'Finn Moss',
  'Gia Rossi',
  'Hal Diaz',
  'Ivy Chen',
  'Jon Park',
  'Kai Sato',
  'Lea Ruiz',
];
const people = (n: number): Participant[] =>
  NAMES.slice(0, n).map((name, i) => ({
    id: `p${i}`,
    name,
    email: `${name.split(' ')[0]!.toLowerCase()}@acme.co`,
    source: 'calendar',
  }));

type Access = 'private' | 'workspace' | 'link';
type Timing = 'today' | 'yesterday' | 'last-week' | 'last-year' | 'live' | 'upcoming';
type Event = 'none' | 'join' | 'no-link';
type Viewer = 'edit' | 'view' | 'trash';

interface State {
  look?: MeetingMetaLook;
  people: number;
  access: Access;
  timing: Timing;
  event: Event;
  viewer: Viewer;
}

const H = 3_600_000;
function times(timing: Timing, now: number) {
  const at = (ms: number) => new Date(now + ms).toISOString();
  switch (timing) {
    case 'today':
      return { startedAt: at(-2 * H), endedAt: at(-1.5 * H), slot: [at(-2 * H), at(-1.5 * H)] };
    case 'yesterday':
      return { startedAt: at(-24 * H), endedAt: at(-23.5 * H), slot: [at(-24 * H), at(-23.5 * H)] };
    case 'last-week':
      return {
        startedAt: at(-6 * 24 * H),
        endedAt: at(-6 * 24 * H + H),
        slot: [at(-144 * H), at(-143 * H)],
      };
    case 'last-year':
      return {
        startedAt: at(-400 * 24 * H),
        endedAt: at(-400 * 24 * H + H),
        slot: [at(-9600 * H), at(-9599 * H)],
      };
    case 'live':
      return { startedAt: at(-0.2 * H), endedAt: null, slot: [at(-0.25 * H), at(0.25 * H)] };
    case 'upcoming':
      return { startedAt: null, endedAt: null, slot: [at(26 * H), at(26.5 * H)] };
  }
}

function Header({
  state,
  now,
  editable: canEdit = true,
}: {
  state: State;
  now: number;
  editable?: boolean;
}) {
  const [list, setList] = useState(() => people(state.people));
  const t = times(state.timing, now);
  const editable = canEdit && state.viewer === 'edit';
  const eventOver = t.slot[1]! < new Date(now).toISOString();
  return (
    <MeetingMetaRow look={state.look ?? 'pill'}>
      <MeetingPrivate visibility={state.access} />
      <MeetingTime startedAt={t.startedAt} endedAt={t.endedAt} />
      {state.event !== 'none' && (
        <MeetingEventLineView
          start={t.slot[0]!}
          end={t.slot[1]!}
          allDay={false}
          recorded={t.startedAt !== null}
          conferenceUrl={
            state.event === 'join' && !eventOver ? 'https://meet.google.com/abc-defg-hij' : null
          }
          conferenceLabel="Google Meet"
        />
      )}
      <ParticipantSummary
        participants={list}
        editable={editable}
        onRemove={async (p) => setList((l) => l.filter((x) => x.id !== p.id))}
      />
      <MeetingAccess state={state.viewer} />
      {editable && (
        <Button size="xs" variant="secondary">
          <IconSparkles data-icon="inline-start" />
          Enhance
        </Button>
      )}
    </MeetingMetaRow>
  );
}

function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-label-12 text-gray-900">{label}</span>
      <ToggleGroup
        variant="outline"
        size="sm"
        aria-label={label}
        value={[String(value)]}
        onValueChange={([next]) => {
          const hit = options.find(([v]) => String(v) === next);
          if (hit) onChange(hit[0]);
        }}
      >
        {options.map(([v, text]) => (
          <ToggleGroupItem key={String(v)} value={String(v)}>
            {text}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

const PRESETS: { title: string; state: State }[] = [
  {
    title: 'Just me, private',
    state: { people: 0, access: 'private', timing: 'today', event: 'none', viewer: 'edit' },
  },
  {
    title: 'Just me, shared',
    state: { people: 0, access: 'workspace', timing: 'yesterday', event: 'none', viewer: 'edit' },
  },
  {
    title: '1:1',
    state: { people: 1, access: 'workspace', timing: 'yesterday', event: 'none', viewer: 'edit' },
  },
  {
    title: 'Me + 2, private',
    state: { people: 2, access: 'private', timing: 'last-week', event: 'none', viewer: 'edit' },
  },
  {
    title: 'Team, link-shared',
    state: { people: 4, access: 'link', timing: 'last-week', event: 'none', viewer: 'edit' },
  },
  {
    title: 'Big meeting',
    state: { people: 12, access: 'workspace', timing: 'today', event: 'none', viewer: 'edit' },
  },
  {
    title: 'Live, with call link',
    state: { people: 3, access: 'workspace', timing: 'live', event: 'join', viewer: 'edit' },
  },
  {
    title: 'Upcoming, from calendar',
    state: { people: 3, access: 'workspace', timing: 'upcoming', event: 'join', viewer: 'edit' },
  },
  {
    title: 'Upcoming, no call link',
    state: { people: 1, access: 'private', timing: 'upcoming', event: 'no-link', viewer: 'edit' },
  },
  {
    title: 'Teammate’s note (view only)',
    state: { people: 4, access: 'workspace', timing: 'yesterday', event: 'none', viewer: 'view' },
  },
  {
    title: 'In trash',
    state: { people: 2, access: 'private', timing: 'last-year', event: 'none', viewer: 'trash' },
  },
  {
    title: 'Never recorded, solo',
    state: { people: 0, access: 'private', timing: 'upcoming', event: 'none', viewer: 'edit' },
  },
];

export function MeetingHeaderPlayground() {
  const hydrated = useHydrated();
  const [now] = useState(() => Date.now());
  const [state, setState] = useState<State>(PRESETS[3]!.state);
  const [look, setLook] = useState<MeetingMetaLook>('pill');
  const [title, setTitle] = useState('Weekly product sync');
  const [darkChoice, setDark] = useState<boolean | null>(null);
  const dark = darkChoice ?? (hydrated && document.documentElement.classList.contains('dark'));
  const set =
    <K extends keyof State>(key: K) =>
    (value: State[K]) =>
      setState((s) => ({ ...s, [key]: value }));
  // Relative dates are the viewer's: render once in the browser only.
  if (!hydrated) return null;

  return (
    <div className="min-h-dvh bg-background-100 pb-24 text-gray-1000">
      <div className="sticky top-0 z-10 border-b border-gray-alpha-400 bg-background-100/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-end gap-x-6 gap-y-3 px-6 py-4">
          <Choice
            label="People besides me"
            value={state.people}
            onChange={set('people')}
            options={[
              [0, 'None'],
              [1, '1'],
              [2, '2'],
              [4, '4'],
              [12, '12'],
            ]}
          />
          <Choice
            label="Access"
            value={state.access}
            onChange={set('access')}
            options={[
              ['private', 'Private'],
              ['workspace', 'Workspace'],
              ['link', 'Link'],
            ]}
          />
          <Choice
            label="When"
            value={state.timing}
            onChange={set('timing')}
            options={[
              ['live', 'Live'],
              ['today', 'Today'],
              ['yesterday', 'Yesterday'],
              ['last-week', 'Last week'],
              ['last-year', 'Last year'],
              ['upcoming', 'Not recorded'],
            ]}
          />
          <Choice
            label="Calendar event"
            value={state.event}
            onChange={set('event')}
            options={[
              ['none', 'None'],
              ['join', 'With call link'],
              ['no-link', 'No link'],
            ]}
          />
          <Choice
            label="Me"
            value={state.viewer}
            onChange={set('viewer')}
            options={[
              ['edit', 'Editor'],
              ['view', 'View only'],
              ['trash', 'In trash'],
            ]}
          />
          <Choice
            label="Style"
            value={look}
            onChange={setLook}
            options={[
              ['plain', 'Plain'],
              ['pill', 'Pill'],
            ]}
          />
          <Choice
            label="Theme"
            value={dark ? 'dark' : 'light'}
            onChange={(v) => {
              document.documentElement.classList.toggle('dark', v === 'dark');
              setDark(v === 'dark');
            }}
            options={[
              ['light', 'Light'],
              ['dark', 'Dark'],
            ]}
          />
        </div>
      </div>

      <NoteColumn className="gap-3 pt-16">
        <p className="text-label-12 text-gray-900">
          Playground: the real header components. Click the people to see or remove them.
        </p>
        <textarea
          aria-label="Title"
          value={title}
          rows={1}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full resize-none bg-transparent text-heading-32 text-gray-1000 [field-sizing:content] outline-none"
        />
        <Header key={JSON.stringify(state)} state={{ ...state, look }} now={now} />
        <div className="mt-4 space-y-2 text-copy-16 text-gray-900">
          <p>Notes start here…</p>
        </div>
      </NoteColumn>

      <div className="mx-auto mt-20 max-w-5xl px-6">
        <h2 className="mb-4 text-heading-20">Every state</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {PRESETS.map((preset) => (
            <div
              key={preset.title}
              className="flex flex-col gap-2 rounded-xl border border-gray-alpha-400 p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-label-12 text-gray-900">{preset.title}</span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setState(preset.state);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                >
                  Try it
                </Button>
              </div>
              <span className="text-heading-20 text-gray-1000">Weekly product sync</span>
              <Header state={{ ...preset.state, look }} now={now} editable={false} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
