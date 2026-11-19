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
          <h2 className="text-heading-16">{title}</h2>
          {action}
        </div>
        {description && <p className="text-copy-14 text-gray-900">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** Flat, bordered list of `Item` rows separated by hairlines (one inset for every row). */
export function SettingsList({ className, ...props }: React.ComponentProps<typeof ItemGroup>) {
  return (
    <ItemGroup
      role="group"
      className={cn(
        'gap-0 overflow-hidden rounded-lg border border-gray-alpha-400',
        '*:data-[slot=item]:rounded-none *:data-[slot=item]:not-last:border-b-gray-alpha-400',
        className,
      )}
      {...props}
    />
  );
}
