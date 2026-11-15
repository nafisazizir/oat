import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Button } from './components/button.tsx';
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
import { Sidebar, SidebarContent, SidebarProvider, SidebarTrigger } from './components/sidebar.tsx';
import { Switch } from './components/switch.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/tabs.tsx';
import { ToggleGroup, ToggleGroupItem } from './components/toggle-group.tsx';
import { cn } from './lib/utils.ts';

describe('cn', () => {
  it('joins conditionally and lets later Tailwind classes win', () => {
    expect(cn('px-2 text-sm', null, { hidden: false, 'font-medium': true }, 'px-4')).toBe(
      'text-sm font-medium px-4',
    );
  });

  it('keeps a token colour next to a scale size (no false conflict)', () => {
    expect(cn('text-sm', 'text-muted-foreground')).toBe('text-sm text-muted-foreground');
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
    expect(save.dataset.variant).toBe('default');
    expect(save.className).toContain('bg-primary');
    expect(save.className).toContain('text-primary-foreground');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel.dataset.variant).toBe('outline');
    expect(cancel.dataset.size).toBe('sm');
  });

  it('renders as its child with asChild', () => {
    render(
      <Button asChild>
        <a href="/notes">Notes</a>
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
        <DialogTrigger asChild>
          <Button>Share</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Share note</DialogTitle>
          <DialogDescription>Anyone with the link can view.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = screen.getByRole('dialog', { name: 'Share note' });
    expect(dialog.className).toContain('bg-popover');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
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
        type="single"
        variant="segmented"
        aria-label="Theme"
        defaultValue="light"
        onValueChange={(next) => (value = next)}
      >
        <ToggleGroupItem value="light">Light</ToggleGroupItem>
        <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
      </ToggleGroup>,
    );
    expect(screen.getByRole('radiogroup', { name: 'Theme' }).dataset.variant).toBe('segmented');
    expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('tab')).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(value).toBe('dark');
    expect(screen.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
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
