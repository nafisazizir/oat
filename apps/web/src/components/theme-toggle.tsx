'use client';

import { Button } from '@oat/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@oat/ui/components/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@oat/ui/components/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@oat/ui/components/tooltip';
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';

import { parsePreference } from '@/lib/theme';

import { useTheme } from './theme-provider';

const options = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
  { value: 'system', label: 'System', Icon: MonitorIcon },
] as const;

/** Top-bar theme menu. The icon follows what's on screen (sun in light, moon in dark). */
export function ThemeMenu() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Theme" data-testid="theme-menu">
              <SunIcon className="dark:hidden" />
              <MoonIcon className="hidden dark:block" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Theme</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-40">
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Segmented light / dark / system control (Settings › Appearance). */
export function ThemeTabs() {
  const { theme, setTheme } = useTheme();
  return (
    <Tabs value={theme} onValueChange={(value) => setTheme(parsePreference(value))}>
      <TabsList aria-label="Theme">
        {options.map(({ value, label, Icon }) => (
          <TabsTrigger key={value} value={value} className="gap-1.5 px-3">
            <Icon />
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
