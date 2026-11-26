'use client';

import type { TemplateDto, TemplateList } from '@oat/services/dto/templates';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@oat/ui/components/dropdown-menu';
import { Spinner } from '@oat/ui/components/spinner';
import { useState, type ReactElement, type ReactNode } from 'react';
import { useWorkspaceHost } from './host';

export function TemplatePicker({
  workspaceId,
  label,
  trigger,
  onSelect,
  leading,
  align = 'end',
  children,
}: {
  workspaceId: string;
  label: string;
  trigger: ReactElement;
  onSelect: (templateId: string) => void;
  /** Menu items above the template list (a separator follows them). */
  leading?: ReactNode;
  align?: 'start' | 'end';
  children?: ReactNode;
}) {
  return (
    <Picker
      key={workspaceId}
      workspaceId={workspaceId}
      label={label}
      trigger={trigger}
      onSelect={onSelect}
      leading={leading}
      align={align}
    >
      {children}
    </Picker>
  );
}

function Picker({
  workspaceId,
  label,
  trigger,
  onSelect,
  leading,
  align,
  children,
}: Parameters<typeof TemplatePicker>[0]) {
  const { client } = useWorkspaceHost();
  const [templates, setTemplates] = useState<TemplateList | null>(null);
  const [loadError, setLoadError] = useState(false);
  const loadTemplates = (open: boolean) => {
    if (!open || templates) return;
    setLoadError(false);
    void client.templates.list(workspaceId).then(setTemplates, () => setLoadError(true));
  };
  const item = (t: TemplateDto) => (
    <DropdownMenuItem key={t.id} data-testid="enhance-template" onClick={() => onSelect(t.id)}>
      {t.name}
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu size="sm" onOpenChange={loadTemplates}>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align={align} className="min-w-52">
        <DropdownMenuGroup>
          {leading && (
            <>
              {leading}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {loadError ? (
            <DropdownMenuItem disabled>Couldn’t load templates</DropdownMenuItem>
          ) : !templates ? (
            <DropdownMenuItem disabled>
              <Spinner />
              Loading…
            </DropdownMenuItem>
          ) : (
            <>
              {templates.builtins.map(item)}
              {templates.custom.length > 0 && <DropdownMenuSeparator />}
              {templates.custom.map(item)}
            </>
          )}
          {children}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
