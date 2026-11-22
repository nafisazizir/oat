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
import { Tooltip, TooltipContent, TooltipTrigger } from '@oat/ui/components/tooltip';
import { IconDeviceDesktop, IconMoon, IconSelector, IconSun } from '@tabler/icons-react';

import { parsePreference, type ThemePreference } from './theme';

const options = [
  { value: 'light', label: 'Light', Icon: IconSun },
  { value: 'dark', label: 'Dark', Icon: IconMoon },
  { value: 'system', label: 'System', Icon: IconDeviceDesktop },
] as const;

export function ThemeMenu({
  theme,
  setTheme,
  showValue = false,
}: {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  showValue?: boolean;
}) {
  const current = options.find(({ value }) => value === theme) ?? options[2];
  return (
    <DropdownMenu>
      {showValue ? (
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="sm" aria-label={`Theme: ${current.label}`} />}
        >
          {current.label}
          <IconSelector data-icon="inline-end" aria-hidden className="text-gray-900" />
        </DropdownMenuTrigger>
      ) : (
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
      )}
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
