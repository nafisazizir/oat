'use client';

import type { OatClient, OatTransport } from '@oat/client';
import {
  createContext,
  useContext,
  type ReactNode,
  type ComponentProps,
  type ComponentType,
} from 'react';
import type { SearchSource } from './sources';

export type AppTarget =
  | { kind: 'document'; id: string; blockId?: string; segmentId?: string; timeMs?: number }
  | { kind: 'search'; q: string }
  | { kind: 'tasks' }
  | { kind: 'assistant'; threadId?: string };

export type LinkComponent = ComponentType<Omit<ComponentProps<'a'>, 'href'> & { href: string }>;

export type FeatureUiAdapter = {
  client: OatClient;
  transport: OatTransport;
  navigate(target: AppTarget): void;
  hrefFor?(target: AppTarget): string | undefined;
  Link?: LinkComponent;
  notify: {
    success(
      message: string,
      options?: { description?: string; action?: { label: string; onClick(): void } },
    ): void;
    error(message: string, options?: { description?: string }): void;
  };
  workspaceId: string;
  user: { id: string; name: string; email: string; image?: string | null };
  searchSources: SearchSource[];
};

const Context = createContext<FeatureUiAdapter | null>(null);

export function FeatureUiProvider({
  value,
  children,
}: {
  value: FeatureUiAdapter;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useFeatureUi() {
  const value = useContext(Context);
  if (!value) throw new Error('FeatureUiProvider is required.');
  return value;
}

export function TargetLink({
  target,
  children,
  ...props
}: Omit<ComponentProps<'a'>, 'href' | 'target'> & { target: AppTarget }) {
  const { hrefFor, navigate, Link = 'a' } = useFeatureUi();
  const href = hrefFor?.(target);
  return href ? (
    <Link {...props} href={href}>
      {children}
    </Link>
  ) : (
    <a
      {...props}
      role="link"
      tabIndex={0}
      onClick={() => navigate(target)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          navigate(target);
        }
      }}
    >
      {children}
    </a>
  );
}
