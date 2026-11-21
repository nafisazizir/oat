'use client';

import { Button } from '@oat/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@oat/ui/components/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@oat/ui/components/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@oat/ui/components/tooltip';
import { IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-react';

import { parsePreference } from '@/lib/theme';

import { useTheme } from './theme-provider';

const options = [
  { value: 'light', label: 'Light', Icon: IconSun },
  { value: 'dark', label: 'Dark', Icon: IconMoon },
  { value: 'system', label: 'System', Icon: IconDeviceDesktop },
] as const;

/** Sidebar theme menu. The icon follows what's on screen (sun in light, moon in dark). */
export function ThemeMenu() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Theme"
                  data-testid="theme-menu"
                />
              }
            />
          }
        >
          <IconSun className="dark:hidden" />
          <IconMoon className="hidden dark:block" />
        </TooltipTrigger>
        <TooltipContent>Theme</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={theme}
            onValueChange={(value) => setTheme(parsePreference(value))}
          >
            {options.map(({ value, label, Icon }) => (
              <DropdownMenuRadioItem key={value} value={value}>
                <Icon />
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Segmented light / dark / system control (Settings › Appearance). A radio-style toggle group, not tabs:
 * there is no panel to switch, and an empty value (clicking the active item) is ignored.
 */
export function ThemeTabs() {
  const { theme, setTheme } = useTheme();
  return (
    <ToggleGroup
      variant="outline"
      spacing={0.5}
      aria-label="Theme"
      value={[theme]}
      onValueChange={([value]) => {
        if (value) setTheme(parsePreference(value));
      }}
    >
      {options.map(({ value, label, Icon }) => (
        <ToggleGroupItem key={value} value={value} className="gap-1.5 px-3">
          <Icon />
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
