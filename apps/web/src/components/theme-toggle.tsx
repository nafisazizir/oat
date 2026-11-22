'use client';

import { ThemeMenu as SharedThemeMenu, useTheme } from '@oat/settings-ui';

export function ThemeMenu({ showValue = false }: { showValue?: boolean }) {
  const { theme, setTheme } = useTheme();
  return <SharedThemeMenu theme={theme} setTheme={setTheme} showValue={showValue} />;
}
