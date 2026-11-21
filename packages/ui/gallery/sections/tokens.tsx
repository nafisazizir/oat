import { useEffect, useState } from 'react';

import { Button } from '@oat/ui/components/button';

const ramps = [
  'background',
  'gray',
  'gray-alpha',
  'brand',
  'blue',
  'red',
  'amber',
  'green',
  'teal',
  'purple',
  'pink',
] as const;
const steps = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000] as const;

export function ColourTokens() {
  return (
    <div className="flex flex-col gap-8">
      <div className="rounded-md bg-brand-700 p-4 text-label-14 text-brand-on">
        Oat brand · brand-700 with brand-on text
      </div>
      <p className="text-copy-14 text-gray-900">
        Steps 100–300 are component backgrounds, 400–600 are borders, 700–800 are fills, and
        900–1000 are text and icons. Gray alpha lets the surface show through.
      </p>
      {ramps.map((ramp) => (
        <section key={ramp} aria-label={`${ramp} ramp`} className="flex flex-col gap-3">
          <h3 className="text-heading-16">{ramp}</h3>
          <div className="grid grid-cols-5 gap-3 sm:grid-cols-10">
            {(ramp === 'background' ? steps.slice(0, 2) : steps).map((step) => (
              <div key={step} className="flex min-w-0 flex-col gap-2">
                <div
                  aria-label={`--ds-${ramp}-${step}`}
                  className="h-16 rounded-md border border-gray-alpha-400"
                  style={{ backgroundColor: `var(--ds-${ramp}-${step})` }}
                />
                <span className="text-label-12-mono text-gray-900">{step}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

const typeRoles = [
  'text-display-32',
  'text-display-24',
  'text-display-20',
  'text-display-14',
  'text-heading-72',
  'text-heading-64',
  'text-heading-56',
  'text-heading-48',
  'text-heading-40',
  'text-heading-32',
  'text-heading-24',
  'text-heading-20',
  'text-heading-16',
  'text-heading-14',
  'text-button-16',
  'text-button-14',
  'text-button-12',
  'text-label-20',
  'text-label-18',
  'text-label-16',
  'text-label-16-mono',
  'text-label-14',
  'text-label-14-mono',
  'text-label-13',
  'text-label-13-mono',
  'text-label-12',
  'text-label-12-mono',
  'text-copy-24',
  'text-copy-20',
  'text-copy-18',
  'text-copy-16',
  'text-copy-14',
  'text-copy-14-mono',
  'text-copy-13',
  'text-copy-13-mono',
] as const;

export function TypeScale() {
  return (
    <div className="flex flex-col divide-y divide-gray-alpha-400 rounded-xl border border-gray-alpha-400 bg-background-100">
      {typeRoles.map((role) => (
        <div
          key={role}
          className="grid min-w-0 items-baseline gap-3 px-5 py-4 sm:grid-cols-[12rem_1fr]"
        >
          <span className="text-label-12-mono text-gray-900">{role}</span>
          <div className="min-w-0 overflow-x-auto">
            {role.startsWith('text-button-') ? (
              <Button variant="outline" className={role}>
                New note
              </Button>
            ) : (
              <p className={role}>Meeting notes</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

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
      <svg
        aria-hidden="true"
        viewBox={`-4 -4 ${s + 8} ${s + 8}`}
        className="size-16 shrink-0 rounded-md border border-gray-alpha-400 bg-background-100"
      >
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          className="text-gray-1000"
        />
      </svg>
      <div className="flex min-w-0 flex-col">
        <span className="text-label-12-mono">{token}</span>
        <span className="text-label-12-mono text-gray-900">{value}</span>
      </div>
    </div>
  );
}

function TokenValue({ token }: { token: string }) {
  const value = useTokenValue(token);
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-label-12-mono">{token}</span>
      <span className="text-label-12-mono text-gray-900">{value}</span>
    </div>
  );
}

export function ShapeTokens() {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <section className="flex flex-col gap-4 rounded-xl border border-gray-alpha-400 bg-background-100 p-5">
        <h3 className="text-heading-16">Radius</h3>
        <div className="flex flex-wrap items-end gap-4">
          {(
            [
              'rounded-sm',
              'rounded-md',
              'rounded-lg',
              'rounded-xl',
              'rounded-2xl',
              'rounded-full',
            ] as const
          ).map((radius) => (
            <div key={radius} className="flex flex-col items-center gap-2">
              <div className={`size-12 border border-gray-alpha-400 bg-gray-100 ${radius}`} />
              <span className="text-label-12-mono text-gray-900">{radius.slice(8)}</span>
            </div>
          ))}
        </div>
        <TokenValue token="--radius" />
      </section>
      <section className="flex flex-col gap-4 rounded-xl border border-gray-alpha-400 bg-background-100 p-5">
        <h3 className="text-heading-16">Floating materials</h3>
        <div className="grid grid-cols-2 gap-6 p-2">
          {(
            ['material-tooltip', 'material-menu', 'material-modal', 'material-fullscreen'] as const
          ).map((material) => (
            <div key={material} className={`flex h-16 items-center justify-center ${material}`}>
              <span className="text-label-12-mono">{material.slice(9)}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-4 rounded-xl border border-gray-alpha-400 bg-background-100 p-5">
        <h3 className="text-heading-16">Spacing</h3>
        <div className="flex flex-col gap-1.5">
          {([1, 2, 3, 4, 6, 8, 12, 16] as const).map((n) => (
            <div key={n} className="flex items-center gap-3">
              <span className="w-6 text-label-12-mono text-gray-900">{n}</span>
              <div
                className="h-2 rounded-full bg-gray-700"
                style={{ width: `calc(var(--spacing) * ${n})` }}
              />
            </div>
          ))}
        </div>
        <TokenValue token="--content-width" />
      </section>
      <section className="flex flex-col gap-4 rounded-xl border border-gray-alpha-400 bg-background-100 p-5">
        <h3 className="text-heading-16">Motion</h3>
        <div className="grid gap-4">
          <EasingCurve token="--easing-standard" />
          <EasingCurve token="--easing-enter" />
          <EasingCurve token="--easing-exit" />
          <TokenValue token="--duration-fast" />
          <TokenValue token="--duration-base" />
          <TokenValue token="--duration-slow" />
        </div>
      </section>
    </div>
  );
}
