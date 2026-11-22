import { useAppShortcut } from '@oat/ui/hooks/use-app-shortcut';
import { FeatureSearch, type DesktopSearchActions } from './feature-search.tsx';

export function DesktopSearch({
  open,
  onOpenChange,
  ...actions
}: DesktopSearchActions & { open: boolean; onOpenChange(open: boolean): void }) {
  useAppShortcut('palette', () => onOpenChange(!open));
  return <FeatureSearch open={open} onOpenChange={onOpenChange} {...actions} />;
}
