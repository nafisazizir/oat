import { useEffect } from 'react';
import { FeatureSearch, type DesktopSearchActions } from './feature-search.tsx';

export function DesktopSearch({
  open,
  onOpenChange,
  ...actions
}: DesktopSearchActions & { open: boolean; onOpenChange(open: boolean): void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key.toLowerCase() !== 'k' ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.repeat
      )
        return;
      event.preventDefault();
      onOpenChange(!open);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);
  return <FeatureSearch open={open} onOpenChange={onOpenChange} {...actions} />;
}
