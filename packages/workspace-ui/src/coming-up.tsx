/**
 * Home → "Coming up": the layout both apps share. A heading over one card; inside, a row per day with the
 * date on the left (big day number, month, weekday, a dot on today) and that day's meetings — or a dashed
 * panel saying why there are none — on the right. Presentational only: each app brings its own rows.
 */
import { cn } from '@oat/ui/lib/utils';
import type { ComponentType, ReactNode } from 'react';

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'long' });
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short' });

export function ComingUp({
  headingId,
  children,
  className,
  ...props
}: React.ComponentProps<'section'> & { headingId: string }) {
  return (
    <section
      aria-labelledby={headingId}
      className={cn('flex flex-col gap-3', className)}
      {...props}
    >
      {/* The page's title row, as on settings: 32px high, 20px type. */}
      <h2 id={headingId} className="flex h-8 items-center px-2 text-heading-20 text-gray-1000">
        Coming up
      </h2>
      <div className="flex flex-col divide-y divide-gray-alpha-400 rounded-xl border border-gray-alpha-400 bg-background-200">
        {children}
      </div>
    </section>
  );
}

/**
 * One day of the card. `date` is a local date; `null` keeps the column's place while the viewer's time zone
 * isn't known yet (the web's server render). `relative` ("Today", "Tomorrow") is read out before the date.
 */
export function ComingUpDay({
  date,
  today = false,
  relative,
  children,
}: {
  date: Date | null;
  today?: boolean;
  relative?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 p-3 sm:flex-row sm:gap-4" data-testid="coming-up-day">
      <h3
        className="flex min-h-10 shrink-0 items-center gap-3 px-2 sm:w-36 sm:items-start sm:pt-1.5"
        aria-label={
          date
            ? [relative, `${date.getDate()} ${MONTH.format(date)}`, WEEKDAY.format(date)]
                .filter(Boolean)
                .join(', ')
            : undefined
        }
      >
        {date && (
          <>
            <span className="text-heading-32 leading-none text-gray-1000 tabular-nums">
              {date.getDate()}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="flex items-center gap-1.5 text-label-14 text-gray-1000">
                {MONTH.format(date)}
                {today && (
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-red-800" />
                )}
              </span>
              <span className="text-label-13 text-gray-900">{WEEKDAY.format(date)}</span>
            </span>
          </>
        )}
      </h3>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/** The dashed panel in a day's event column: nothing scheduled, or a calendar that needs connecting. */
export function ComingUpNotice({
  icon: Icon,
  title,
  description,
  action,
  ...props
}: Omit<React.ComponentProps<'div'>, 'title'> & {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-gray-alpha-400 px-4 py-8 text-center text-balance"
      {...props}
    >
      <Icon aria-hidden className="mb-2 size-5 text-gray-900" />
      <p className="text-label-14 text-gray-1000">{title}</p>
      {description && <p className="max-w-sm text-copy-13 text-gray-900">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Midnight (local) of the day `date` falls on. */
export function startOfDay(date: Date): Date {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}
