'use client';

import { TEMPLATE_LIMITS, templateInputSchema } from '@oat/ai/templates';
import type { TemplateSection } from '@oat/core';
import { cn } from '@oat/ui';
import { Button } from '@oat/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@oat/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@oat/ui/components/dropdown-menu';
import { Input } from '@oat/ui/components/input';
import { Label } from '@oat/ui/components/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@oat/ui/components/tabs';
import { Textarea } from '@oat/ui/components/textarea';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GripVerticalIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { DeleteTemplateDialog } from './delete-template-dialog';
import { templateClient, type TemplateFields } from './template-client';
import { TemplatePreview } from './template-preview';

type EditableSection = TemplateSection & { key: string };

let keySeq = 0;
const newKey = () => `s${++keySeq}`;
const withKeys = (sections: readonly TemplateSection[]): EditableSection[] =>
  sections.map((s) => ({ heading: s.heading, instructions: s.instructions, key: newKey() }));

const fieldsOf = (name: string, instructions: string, sections: readonly EditableSection[]) => ({
  name,
  instructions,
  sections: sections.map(({ heading, instructions: how }) => ({ heading, instructions: how })),
});

const sameFields = (a: TemplateFields, b: TemplateFields) =>
  JSON.stringify(a) === JSON.stringify(b);

function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

export type TemplateEditorProps =
  | {
      mode: 'create';
      workspaceId: string;
      initial: TemplateFields;
    }
  | {
      mode: 'edit';
      workspaceId: string;
      templateId: string;
      initial: TemplateFields;
      canDuplicate: boolean;
    };

/**
 * Custom template editor: name, description, and ordered sections (drag the grip or use the arrow keys on
 * it to reorder; add/remove), with a live preview. Saves the whole template in one request.
 */
export function TemplateEditor(props: TemplateEditorProps) {
  const router = useRouter();
  const ids = useId();
  const [saved, setSaved] = useState<TemplateFields>(props.initial);
  const [name, setName] = useState(props.initial.name);
  const [instructions, setInstructions] = useState(props.initial.instructions);
  const [sections, setSections] = useState<EditableSection[]>(() =>
    withKeys(props.initial.sections),
  );
  const [pending, startTransition] = useTransition();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const fields = useMemo(
    () => fieldsOf(name, instructions, sections),
    [name, instructions, sections],
  );
  const latest = useRef(fields);
  useEffect(() => {
    latest.current = fields;
  }, [fields]);
  const dirty = props.mode === 'create' || !sameFields(fields, saved);
  const validation = templateInputSchema.safeParse(fields);
  const firstIssue = validation.success ? null : validation.error.issues[0]!.message;

  const duplicateHeadings = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sections) {
      const key = s.heading.trim().toLocaleLowerCase();
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [sections]);

  // Warn before leaving with unsaved edits (tab close / reload).
  useEffect(() => {
    if (!dirty || props.mode === 'create') return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty, props.mode]);

  function updateSection(key: string, patch: Partial<TemplateSection>) {
    setSections((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }

  function moveSection(from: number, to: number, announce = true) {
    if (to < 0 || to >= sections.length || from === to) return;
    const heading = sections[from]!.heading.trim() || 'Untitled section';
    setSections((list) => move(list, from, to));
    if (announce) {
      setAnnouncement(`Moved ${heading} to position ${to + 1} of ${sections.length}.`);
    }
  }

  function addSection() {
    const key = newKey();
    setSections((list) => [...list, { key, heading: '', instructions: '' }]);
    // Focus the new heading once it renders.
    requestAnimationFrame(() =>
      rowRefs.current.get(key)?.querySelector<HTMLInputElement>('input')?.focus(),
    );
  }

  function removeSection(index: number) {
    const heading = sections[index]!.heading.trim() || 'Untitled section';
    setSections((list) => list.filter((_, i) => i !== index));
    setAnnouncement(`Removed ${heading}.`);
  }

  function save() {
    if (!validation.success) {
      setShowErrors(true);
      toast.error(firstIssue ?? 'Check the template for errors.');
      return;
    }
    const data = validation.data;
    const sent = fields;
    startTransition(async () => {
      try {
        if (props.mode === 'create') {
          const { template } = await templateClient.create(props.workspaceId, data);
          toast.success('Template created');
          router.replace(`/templates/${template.id}` as Route);
          router.refresh();
          return;
        }
        const { template } = await templateClient.update(props.templateId, data);
        const next = {
          name: template.name,
          instructions: template.instructions,
          sections: template.sections,
        };
        setSaved(next);
        // Only adopt the server's (trimmed) copy if nothing was typed while the request was in flight;
        // otherwise keep the newer text, which then simply shows as unsaved.
        if (sameFields(latest.current, sent)) {
          setName(next.name);
          setInstructions(next.instructions);
          setSections((list) =>
            list.map((s, i) => ({ ...s, ...next.sections[i] }) as EditableSection),
          );
          setShowErrors(false);
        }
        toast.success('Template saved');
        router.refresh();
      } catch (error) {
        toast.error((error as Error).message);
      }
    });
  }

  function discard() {
    setName(saved.name);
    setInstructions(saved.instructions);
    setSections(withKeys(saved.sections));
    setShowErrors(false);
  }

  function duplicate(confirmed = false) {
    if (props.mode !== 'edit') return;
    if (dirty && !confirmed) {
      setConfirmDuplicate(true);
      return;
    }
    setConfirmDuplicate(false);
    startTransition(async () => {
      try {
        const { template } = await templateClient.duplicate(props.workspaceId, props.templateId);
        toast.success(`Created ${template.name}`);
        router.push(`/templates/${template.id}` as Route);
        router.refresh();
      } catch (error) {
        toast.error((error as Error).message);
      }
    });
  }

  const nameInvalid = showErrors && !name.trim();

  return (
    <div className="flex flex-col gap-8" data-testid="template-editor">
      <div className="flex flex-col gap-1">
        <div className="flex items-start gap-2">
          <Label htmlFor={`${ids}-name`} className="sr-only">
            Template name
          </Label>
          <Input
            id={`${ids}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Template name"
            maxLength={TEMPLATE_LIMITS.name}
            aria-invalid={nameInvalid || undefined}
            className="h-auto border-transparent bg-transparent px-0 py-1 font-heading text-3xl font-medium shadow-none focus-visible:border-transparent focus-visible:ring-0 md:text-3xl dark:bg-transparent"
          />
          {props.mode === 'edit' && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Template actions"
                  className="mt-1.5"
                >
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {props.canDuplicate && (
                  <DropdownMenuItem onSelect={() => duplicate()} disabled={pending}>
                    Duplicate
                  </DropdownMenuItem>
                )}
                {props.canDuplicate && <DropdownMenuSeparator />}
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                  <Trash2Icon />
                  Delete template
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <Label htmlFor={`${ids}-description`} className="sr-only">
          Description
        </Label>
        <Textarea
          id={`${ids}-description`}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="What is this template for? Anything the AI should keep in mind for the whole note."
          maxLength={TEMPLATE_LIMITS.instructions}
          className="min-h-0 resize-none border-transparent bg-transparent px-0 text-base text-muted-foreground shadow-none focus-visible:border-transparent focus-visible:ring-0 md:text-base dark:bg-transparent"
        />
      </div>

      <Tabs defaultValue="sections" className="gap-6">
        <TabsList>
          <TabsTrigger value="sections">Sections</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>

        <TabsContent value="sections" className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Enhanced notes follow these sections in order. Tell the AI what belongs in each.
          </p>
          <ol className="flex flex-col gap-3" aria-label="Sections">
            {sections.map((section, index) => {
              const headingId = `${ids}-heading-${section.key}`;
              const isDuplicate =
                (duplicateHeadings.get(section.heading.trim().toLocaleLowerCase()) ?? 0) > 1;
              const headingInvalid = (showErrors && !section.heading.trim()) || isDuplicate;
              const label = section.heading.trim() || `Section ${index + 1}`;
              return (
                <li
                  key={section.key}
                  ref={(el) => {
                    if (el) rowRefs.current.set(section.key, el);
                    else rowRefs.current.delete(section.key);
                  }}
                  data-testid="template-section"
                  className={cn(
                    'group/section flex gap-2 rounded-xl border bg-card p-3 shadow-xs transition-[opacity,box-shadow] duration-fast',
                    dragKey === section.key && 'opacity-50 ring-2 ring-ring/40',
                  )}
                  onDragOver={(event) => {
                    if (!dragKey) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    const from = sections.findIndex((s) => s.key === dragKey);
                    const rect = event.currentTarget.getBoundingClientRect();
                    const before = event.clientY < rect.top + rect.height / 2;
                    let to = before ? index : index + 1;
                    if (from < to) to -= 1;
                    if (from !== to) moveSection(from, to, false);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (!dragKey) return;
                    const at = sections.findIndex((s) => s.key === dragKey);
                    setAnnouncement(`Moved ${label} to position ${at + 1} of ${sections.length}.`);
                  }}
                >
                  <div className="flex flex-col items-center gap-1 pt-1">
                    <button
                      type="button"
                      draggable
                      aria-label={`Reorder ${label}`}
                      aria-describedby={`${ids}-reorder-help`}
                      data-testid="section-handle"
                      className="flex size-7 cursor-grab items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 active:cursor-grabbing"
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', label);
                        const row = rowRefs.current.get(section.key);
                        if (row) event.dataTransfer.setDragImage(row, 24, 20);
                        setDragKey(section.key);
                      }}
                      onDragEnd={() => setDragKey(null)}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowUp') {
                          event.preventDefault();
                          moveSection(index, index - 1);
                        } else if (event.key === 'ArrowDown') {
                          event.preventDefault();
                          moveSection(index, index + 1);
                        }
                      }}
                    >
                      <GripVerticalIcon className="size-4" />
                    </button>
                    <span
                      className="text-xs text-muted-foreground tabular-nums"
                      aria-hidden
                      data-testid="section-number"
                    >
                      {index + 1}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <Label htmlFor={headingId} className="sr-only">
                        Section {index + 1} heading
                      </Label>
                      <Input
                        id={headingId}
                        value={section.heading}
                        onChange={(e) => updateSection(section.key, { heading: e.target.value })}
                        placeholder="Heading"
                        maxLength={TEMPLATE_LIMITS.heading}
                        aria-invalid={headingInvalid || undefined}
                        aria-describedby={isDuplicate ? `${headingId}-error` : undefined}
                        className="font-medium"
                      />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`${label} options`}
                            className="text-muted-foreground"
                          >
                            <MoreHorizontalIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={index === 0}
                            onSelect={() => moveSection(index, index - 1)}
                          >
                            <ArrowUpIcon />
                            Move up
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={index === sections.length - 1}
                            onSelect={() => moveSection(index, index + 1)}
                          >
                            <ArrowDownIcon />
                            Move down
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={sections.length <= TEMPLATE_LIMITS.minSections}
                            onSelect={() => removeSection(index)}
                          >
                            <Trash2Icon />
                            Remove section
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {isDuplicate && (
                      <p id={`${headingId}-error`} className="text-xs text-destructive">
                        Another section already uses this heading.
                      </p>
                    )}
                    <Label htmlFor={`${headingId}-instructions`} className="sr-only">
                      Section {index + 1} instructions
                    </Label>
                    <Textarea
                      id={`${headingId}-instructions`}
                      value={section.instructions}
                      onChange={(e) => updateSection(section.key, { instructions: e.target.value })}
                      placeholder="What should go in this section?"
                      maxLength={TEMPLATE_LIMITS.sectionInstructions}
                      className="min-h-14 resize-none text-sm md:text-sm"
                    />
                  </div>
                </li>
              );
            })}
          </ol>
          <p id={`${ids}-reorder-help`} className="sr-only">
            Drag to reorder, or press the up and down arrow keys.
          </p>
          <div aria-live="polite" className="sr-only">
            {announcement}
          </div>
          <Button
            variant="outline"
            className="self-start"
            onClick={addSection}
            disabled={sections.length >= TEMPLATE_LIMITS.maxSections}
          >
            <PlusIcon />
            Add section
          </Button>
          {sections.length >= TEMPLATE_LIMITS.maxSections && (
            <p className="text-xs text-muted-foreground">
              Templates can have up to {TEMPLATE_LIMITS.maxSections} sections.
            </p>
          )}
        </TabsContent>

        <TabsContent value="preview">
          <TemplatePreview name={name} instructions={instructions} sections={fields.sections} />
        </TabsContent>
      </Tabs>

      <div className="sticky bottom-0 z-20 -mx-6 -mb-10 border-t bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75 sm:-mx-8 sm:-mb-14">
        <div className="flex items-center justify-between gap-3 px-6 py-3 sm:px-8">
          <p className="truncate text-sm text-muted-foreground" data-testid="save-status">
            {props.mode === 'create'
              ? 'New template'
              : dirty
                ? showErrors && firstIssue
                  ? firstIssue
                  : 'Unsaved changes'
                : 'All changes saved'}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {props.mode === 'create' ? (
              <Button variant="ghost" onClick={() => router.push('/templates')} disabled={pending}>
                Cancel
              </Button>
            ) : (
              <Button variant="ghost" onClick={discard} disabled={!dirty || pending}>
                Discard
              </Button>
            )}
            <Button onClick={save} disabled={!dirty || pending}>
              {pending && <Loader2Icon className="animate-spin" />}
              {props.mode === 'create' ? 'Create template' : 'Save'}
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={confirmDuplicate} onOpenChange={setConfirmDuplicate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Duplicate without your changes?</DialogTitle>
            <DialogDescription>
              The copy is made from the last saved version. Save first to include your edits.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDuplicate(false)}>
              Cancel
            </Button>
            <Button onClick={() => duplicate(true)}>Duplicate saved version</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {props.mode === 'edit' && (
        <DeleteTemplateDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          templateId={props.templateId}
          name={saved.name}
        />
      )}
    </div>
  );
}
