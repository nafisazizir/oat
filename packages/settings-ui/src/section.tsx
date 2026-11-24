import { cn } from '@oat/ui';
import { ItemGroup } from '@oat/ui/components/item';

/** A settings group: an h2 with an optional one-line description and a trailing action. */
export function SettingsSection({
  title,
  description,
  action,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<'section'>, 'title'> & {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className={cn('flex flex-col gap-3', className)} {...props}>
      <div className="flex flex-col gap-1">
        <div className="flex min-h-6 items-center justify-between gap-4">
          <h2 className="text-heading-16 text-gray-1000">{title}</h2>
          {action}
        </div>
        {description && <p className="text-copy-14 text-gray-900">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** Quiet settings rows, without an enclosing card. */
export function SettingsList({ className, ...props }: React.ComponentProps<typeof ItemGroup>) {
  return (
    <ItemGroup
      role="group"
      className={cn(
        'gap-0',
        '*:data-[slot=item]:rounded-none *:data-[slot=item]:border-0 *:data-[slot=item]:px-0 *:data-[slot=item]:py-3 [&>[data-slot=item]+[data-slot=item]]:border-t [&>[data-slot=item]+[data-slot=item]]:border-gray-alpha-400',
        className,
      )}
      {...props}
    />
  );
}

/**
 * The page title, the same on every settings page: a 32px row that sits level with the first row of the
 * settings navigation, with an optional trailing action and a one-line description under it.
 */
export function SettingsHeading({
  children,
  description,
  action,
}: {
  children: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-1">
      <div className="flex h-8 items-center justify-between gap-4">
        <h1 className="truncate text-heading-20 text-gray-1000">{children}</h1>
        {action}
      </div>
      {description && <p className="text-copy-14 text-gray-900">{description}</p>}
    </header>
  );
}
