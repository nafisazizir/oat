import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Button } from './components/button.tsx';
import { ChartStyle } from './components/chart.tsx';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './components/command.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from './components/dialog.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from './components/dropdown-menu.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/select.tsx';
import { Sidebar, SidebarContent, SidebarProvider, SidebarTrigger } from './components/sidebar.tsx';
import { Switch } from './components/switch.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/tabs.tsx';
import { ToggleGroup, ToggleGroupItem } from './components/toggle-group.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/tooltip.tsx';
import { cn } from './lib/utils.ts';

describe('cn', () => {
  it('joins conditionally and lets later Tailwind classes win', () => {
    expect(cn('px-2 text-copy-14', null, { hidden: false, underline: true }, 'px-4')).toBe(
      'text-copy-14 underline px-4',
    );
  });

  it('keeps a token colour next to a scale size (no false conflict)', () => {
    expect(cn('text-copy-14', 'text-gray-900')).toBe('text-copy-14 text-gray-900');
  });
});

describe('ChartStyle', () => {
  it('scopes themed series colors and keeps declaration delimiters out of the stylesheet', () => {
    const { container } = render(
      <ChartStyle
        id="chart:meetings"
        config={{
          'per week': { theme: { light: 'var(--ds-gray-900)', dark: 'oklch(0.9 0 0)' } },
          invalid: { color: 'gray; color: gray' },
        }}
      />,
    );
    const css = container.querySelector('style')?.textContent;
    expect(css).toContain('[data-chart="chart\\3a meetings"]');
    expect(css).toContain('.dark [data-chart=');
    expect(css).toContain('--color-per\\20 week: var(--ds-gray-900);');
    expect(css).toContain('--color-per\\20 week: oklch(0.9 0 0);');
    expect(css).not.toContain('--color-invalid');
  });
});

describe('Tooltip', () => {
  it.each([false, true])('exposes the focused tooltip unless disabled=%s', async (disabled) => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <Tooltip disabled={disabled}>
          <TooltipTrigger render={<Button aria-label="New chat" />}>New</TooltipTrigger>
          <TooltipContent>New chat</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    await user.tab();
    if (disabled) expect(screen.queryByRole('tooltip')).toBeNull();
    else expect(await screen.findByRole('tooltip', { name: 'New chat' })).toBeTruthy();
  });
});

describe('Button', () => {
  it('renders token-driven variants', () => {
    render(
      <>
        <Button>Save</Button>
        <Button variant="outline" size="sm">
          Cancel
        </Button>
      </>,
    );
    const save = screen.getByRole('button', { name: 'Save' });

    expect(save.className).toContain('bg-gray-1000');
    expect(save.className).toContain('text-background-100');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel.className).toContain('border-gray-alpha-400');
    expect(cancel.className).toContain('h-8');
  });

  it('renders a link with render', () => {
    render(
      <Button role="link" nativeButton={false} render={<a href="/notes" />}>
        Notes
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Notes' });
    expect(link.dataset.slot).toBe('button');
  });
});

describe('Dialog', () => {
  it('opens from its trigger with an accessible title and closes again', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger render={<Button />}>Share</DialogTrigger>
        <DialogContent>
          <DialogTitle>Share note</DialogTitle>
          <DialogDescription>Anyone with the link can view.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = screen.getByRole('dialog', { name: 'Share note' });
    expect(dialog.className).toContain('material-modal');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Base UI consumer composition', () => {
  it('opens a labelled menu group and activates an item with onClick', async () => {
    const user = userEvent.setup();
    let picked = false;
    render(
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button />}>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Meeting</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => {
                picked = true;
              }}
            >
              Duplicate
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(await screen.findByRole('group', { name: 'Meeting' })).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(picked).toBe(true);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('shows item labels before the select popup mounts and updates the selection', async () => {
    const user = userEvent.setup();
    render(
      <Select
        items={{ general: 'General meeting', customer: 'Customer call' }}
        defaultValue="general"
      >
        <SelectTrigger aria-label="Template">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="general">General meeting</SelectItem>
          <SelectItem value="customer">Customer call</SelectItem>
        </SelectContent>
      </Select>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Template' });
    expect(trigger.textContent).toBe('General meeting');
    expect(trigger.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: 'Customer call' }));
    expect(trigger.textContent).toBe('Customer call');
  });

  it('shows an empty select placeholder without inventing a selection', () => {
    render(
      <Select items={[]}>
        <SelectTrigger aria-label="Template">
          <SelectValue placeholder="Choose template" />
        </SelectTrigger>
      </Select>,
    );
    expect(screen.getByRole('combobox', { name: 'Template' }).textContent).toContain(
      'Choose template',
    );
  });
});

describe('Switch', () => {
  it('toggles its checked state', async () => {
    const user = userEvent.setup();
    render(<Switch aria-label="Auto-record" />);
    const toggle = screen.getByRole('switch', { name: 'Auto-record' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });
});

describe('Tabs', () => {
  it.each([true, false])(
    'activateOnFocus=%s controls keyboard panel activation',
    async (activateOnFocus) => {
      const user = userEvent.setup();
      render(
        <Tabs defaultValue="notes">
          <TabsList {...(activateOnFocus ? {} : { activateOnFocus: false })}>
            <TabsTrigger value="notes">Notes</TabsTrigger>
            <TabsTrigger value="transcript">Transcript</TabsTrigger>
          </TabsList>
          <TabsContent value="notes">My notes</TabsContent>
          <TabsContent value="transcript">Full transcript</TabsContent>
        </Tabs>,
      );
      await user.tab();
      await user.keyboard('{ArrowRight}');
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Transcript' }));
      expect(screen.getByRole('tabpanel').textContent).toBe(
        activateOnFocus ? 'Full transcript' : 'My notes',
      );
      if (!activateOnFocus) {
        await user.keyboard('{Enter}');
        expect(screen.getByRole('tabpanel').textContent).toBe('Full transcript');
      }
    },
  );

  it('shows the panel of the selected tab', async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="notes">
        <TabsList>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="transcript">Transcript</TabsTrigger>
        </TabsList>
        <TabsContent value="notes">My notes</TabsContent>
        <TabsContent value="transcript">Full transcript</TabsContent>
      </Tabs>,
    );
    expect(screen.getByRole('tabpanel').textContent).toBe('My notes');
    await user.click(screen.getByRole('tab', { name: 'Transcript' }));
    expect(screen.getByRole('tabpanel').textContent).toBe('Full transcript');
  });
});

describe('ToggleGroup (segmented)', () => {
  it('is a one-of-N radio choice with no tab panels (9.3)', async () => {
    const user = userEvent.setup();
    let value = 'light';
    render(
      <ToggleGroup
        variant="outline"
        aria-label="Theme"
        defaultValue={['light']}
        onValueChange={([next]) => (value = next ?? value)}
      >
        <ToggleGroupItem value="light">Light</ToggleGroupItem>
        <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
      </ToggleGroup>,
    );
    expect(screen.getByRole('group', { name: 'Theme' }).dataset.variant).toBe('outline');
    expect(screen.getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('tab')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Dark' }));
    expect(value).toBe('dark');
    expect(screen.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Command', () => {
  it('filters items as you type', async () => {
    const user = userEvent.setup();
    render(
      <Command>
        <CommandInput placeholder="Search…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Go to">
            <CommandItem>Settings</CommandItem>
            <CommandItem>Calendar</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>,
    );
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await user.type(screen.getByPlaceholderText('Search…'), 'sett');
    await waitFor(() =>
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Settings']),
    );
    await user.type(screen.getByPlaceholderText('Search…'), 'zzz');
    expect(await screen.findByText('No results.')).toBeTruthy();
  });
});

describe('Sidebar', () => {
  it('collapses and expands with its trigger', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Private</SidebarContent>
        </Sidebar>
        <SidebarTrigger />
      </SidebarProvider>,
    );
    const sidebar = () => container.querySelector('[data-slot="sidebar"]') as HTMLElement;
    expect(sidebar().dataset.state).toBe('expanded');
    await user.click(screen.getByRole('button', { name: 'Toggle Sidebar' }));
    expect(sidebar().dataset.state).toBe('collapsed');
  });

  it('toggles with Cmd/Ctrl+B, except while typing in a field or editor', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Private</SidebarContent>
        </Sidebar>
        <input aria-label="Title" />
        <textarea aria-label="Notes" />
        <div className="ProseMirror" contentEditable suppressContentEditableWarning>
          <p data-testid="editor-paragraph">Bold me</p>
        </div>
      </SidebarProvider>,
    );
    const state = () =>
      (container.querySelector('[data-slot="sidebar"]') as HTMLElement).dataset.state;

    for (const target of [
      screen.getByLabelText('Title'),
      screen.getByLabelText('Notes'),
      screen.getByTestId('editor-paragraph'),
    ]) {
      const notCancelled = fireEvent.keyDown(target, { key: 'b', metaKey: true });
      expect(notCancelled).toBe(true); // default (e.g. bold) is left alone
      expect(state()).toBe('expanded');
    }

    fireEvent.keyDown(document.body, { key: 'b', ctrlKey: true });
    expect(state()).toBe('collapsed');
    fireEvent.keyDown(document.body, { key: 'b', metaKey: true });
    expect(state()).toBe('expanded');
  });
});
