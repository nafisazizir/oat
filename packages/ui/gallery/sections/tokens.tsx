import { useEffect, useState } from 'react';

type Swatch = { token: string; on?: string; note?: string };

const colourGroups: { title: string; swatches: Swatch[] }[] = [
  {
    title: 'Surfaces',
    swatches: [
      { token: '--background', on: '--foreground', note: 'oat paper' },
      { token: '--card', on: '--card-foreground' },
      { token: '--popover', on: '--popover-foreground' },
      { token: '--muted', on: '--muted-foreground' },
      { token: '--secondary', on: '--secondary-foreground' },
      { token: '--accent', on: '--accent-foreground', note: 'hover' },
    ],
  },
  {
    title: 'Ink & status',
    swatches: [
      { token: '--primary', on: '--primary-foreground', note: 'the one accent' },
      { token: '--destructive', on: '--destructive-foreground' },
      { token: '--success', on: '--success-foreground' },
      { token: '--warning', on: '--warning-foreground' },
      { token: '--ring' },
      { token: '--selection' },
    ],
  },
  {
    title: 'Lines & sidebar',
    swatches: [
      { token: '--border' },
      { token: '--input' },
      { token: '--overlay', note: 'modal scrim' },
      { token: '--sidebar', on: '--sidebar-foreground' },
      { token: '--sidebar-accent', on: '--sidebar-accent-foreground' },
      { token: '--sidebar-border' },
    ],
  },
  {
    title: 'Oat-specific',
    swatches: [
      { token: '--me', on: '--me-foreground', note: 'my mic' },
      { token: '--them', on: '--them-foreground', note: 'system audio' },
      { token: '--my-text', note: 'typed by me' },
      { token: '--ai-text', note: 'added by AI' },
      { token: '--chart-1' },
      { token: '--chart-2' },
    ],
  },
];

function SwatchTile({ token, on, note }: Swatch) {
  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex h-16 items-end rounded-lg border p-2 shadow-xs"
        style={{ background: `var(${token})`, color: on ? `var(${on})` : undefined }}
      >
        {on ? <span className="font-heading text-xl leading-none">Aa</span> : null}
      </div>
      <div className="flex flex-col">
        <span className="font-mono text-xs">{token}</span>
        {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
      </div>
    </div>
  );
}

export function ColourTokens() {
  return (
    <div className="flex flex-col gap-8">
      {colourGroups.map((group) => (
        <div key={group.title} className="flex flex-col gap-3">
          <h3 className="font-sans text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {group.title}
          </h3>
          <div className="grid grid-cols-3 gap-4 md:grid-cols-6">
            {group.swatches.map((s) => (
              <SwatchTile key={s.token} {...s} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const typeScale = [
  {
    cls: 'font-heading text-4xl',
    size: '4xl',
    label: 'Display',
    sample: 'Notes that write themselves',
  },
  { cls: 'font-heading text-3xl', size: '3xl', label: 'Note title', sample: 'Weekly design sync' },
  {
    cls: 'font-heading text-2xl',
    size: '2xl',
    label: 'Heading',
    sample: 'Decisions and next steps',
  },
  { cls: 'font-heading text-xl', size: 'xl', label: 'Section', sample: 'Onboarding drop-off' },
  {
    cls: 'text-lg',
    size: 'lg',
    label: 'Lead',
    sample: 'A calm place for everything you heard and said.',
  },
  {
    cls: 'text-base',
    size: 'base',
    label: 'Body',
    sample: 'Rough notes in, clean notes out — your words stay yours, the AI fills the gaps.',
  },
  { cls: 'text-sm', size: 'sm', label: 'UI', sample: 'Menus, buttons, sidebar, transcript lines.' },
  { cls: 'text-xs', size: 'xs', label: 'Caption', sample: 'Thu 14 Nov · 10:02 · Priya' },
  {
    cls: 'font-mono text-sm',
    size: 'sm',
    label: 'Mono',
    sample: 'const note = await enhance(draft);',
  },
];

export function TypeScale() {
  return (
    <div className="flex flex-col divide-y rounded-xl border bg-card">
      {typeScale.map((t) => (
        <div key={t.label} className="flex items-baseline gap-6 px-5 py-4">
          <div className="flex w-28 shrink-0 flex-col">
            <span className="text-xs font-medium">{t.label}</span>
            <span className="font-mono text-xs text-muted-foreground">text-{t.size}</span>
          </div>
          <span className={`${t.cls} truncate`}>{t.sample}</span>
        </div>
      ))}
    </div>
  );
}

/** Reads a token's live value so the gallery always shows what the CSS says. */
function useTokenValue(token: string) {
  const [value, setValue] = useState('');
  useEffect(() => {
    const read = () =>
      setValue(getComputedStyle(document.documentElement).getPropertyValue(token).trim());
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [token]);
  return value;
}

function EasingCurve({ token }: { token: string }) {
  const value = useTokenValue(token);
  const [x1 = 0, y1 = 0, x2 = 1, y2 = 1] = (/cubic-bezier\(([^)]+)\)/.exec(value)?.[1] ?? '')
    .split(',')
    .map(Number);
  const s = 56;
  const path = `M0 ${s} C ${x1 * s} ${s - y1 * s}, ${x2 * s} ${s - y2 * s}, ${s} 0`;
  return (
    <div className="flex items-center gap-3">
      <svg viewBox={`-4 -4 ${s + 8} ${s + 8}`} className="size-16 rounded-md border bg-background">
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          className="text-primary"
        />
      </svg>
      <div className="flex flex-col">
        <span className="font-mono text-xs">{token}</span>
        <span className="font-mono text-xs text-muted-foreground">{value}</span>
      </div>
    </div>
  );
}

function TokenValue({ token }: { token: string }) {
  const value = useTokenValue(token);
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-mono text-xs">{token}</span>
      <span className="font-mono text-xs text-muted-foreground">{value}</span>
    </div>
  );
}

export function ShapeTokens() {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-5">
        <h3 className="font-sans text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Radius · one knob, <code className="font-mono normal-case">--radius</code>
        </h3>
        <div className="flex items-end gap-4">
          {(
            [
              'rounded-sm',
              'rounded-md',
              'rounded-lg',
              'rounded-xl',
              'rounded-2xl',
              'rounded-full',
            ] as const
          ).map((r) => (
            <div key={r} className="flex flex-col items-center gap-2">
              <div className={`size-12 border-2 border-primary/60 bg-secondary ${r}`} />
              <span className="font-mono text-xs text-muted-foreground">{r.slice(8)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-5">
        <h3 className="font-sans text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Elevation
        </h3>
        <div className="flex gap-4">
          {(['shadow-xs', 'shadow-sm', 'shadow-md', 'shadow-lg'] as const).map((s) => (
            <div
              key={s}
              className={`flex h-14 flex-1 items-center justify-center rounded-lg bg-popover ${s}`}
            >
              <span className="font-mono text-xs text-muted-foreground">{s.slice(7)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-5">
        <h3 className="font-sans text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Spacing · <code className="font-mono normal-case">--space</code> × n
        </h3>
        <div className="flex flex-col gap-1.5">
          {([1, 2, 3, 4, 6, 8, 12, 16] as const).map((n) => (
            <div key={n} className="flex items-center gap-3">
              <span className="w-6 font-mono text-xs text-muted-foreground">{n}</span>
              <div
                className="h-2 rounded-full bg-primary/70"
                style={{ width: `calc(var(--space) * ${n})` }}
              />
            </div>
          ))}
        </div>
        <TokenValue token="--content-width" />
        <TokenValue token="--sidebar-width-default" />
      </div>
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-5">
        <h3 className="font-sans text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Motion
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <EasingCurve token="--easing-standard" />
          <EasingCurve token="--easing-enter" />
          <EasingCurve token="--easing-exit" />
          <div className="flex flex-col justify-center gap-1.5">
            <TokenValue token="--duration-fast" />
            <TokenValue token="--duration-base" />
            <TokenValue token="--duration-slow" />
          </div>
        </div>
      </div>
    </div>
  );
}
