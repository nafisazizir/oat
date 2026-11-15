'use client';

import { Button } from '@oat/ui/components/button';
import { Separator } from '@oat/ui/components/separator';
import { SidebarTrigger } from '@oat/ui/components/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@oat/ui/components/tooltip';
import { ChevronRightIcon, SearchIcon } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment } from 'react';

import { breadcrumbsFor, type Crumb } from '@/lib/navigation';

import { ThemeMenu } from '../theme-toggle';
import { useCommandMenu } from './command-menu';
import { useShellData } from './shell-data';

function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <Fragment key={`${index}-${crumb.label}`}>
              {index > 0 && (
                <li aria-hidden className="hidden shrink-0 items-center sm:flex">
                  <ChevronRightIcon className="size-3.5 opacity-60" />
                </li>
              )}
              <li className={last ? 'min-w-0 truncate' : 'hidden shrink-0 sm:block'}>
                {last ? (
                  <span aria-current="page" className="font-medium text-foreground">
                    {crumb.label}
                  </span>
                ) : crumb.href ? (
                  <Link
                    href={crumb.href as Route}
                    className="rounded-sm px-0.5 transition-colors duration-fast hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="px-0.5">{crumb.label}</span>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

/** Sticky bar above the content: sidebar toggle, breadcrumbs, search and theme. */
export function TopBar() {
  const pathname = usePathname();
  const { setOpen } = useCommandMenu();
  const shell = useShellData();

  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur-md">
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarTrigger data-testid="sidebar-trigger" />
        </TooltipTrigger>
        <TooltipContent>Toggle sidebar · ⌘B</TooltipContent>
      </Tooltip>
      <Separator
        orientation="vertical"
        className="mr-1 data-vertical:h-4 data-vertical:self-center"
      />
      <Breadcrumbs crumbs={breadcrumbsFor(shell, pathname)} />
      <div className="ml-auto flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Search"
              onClick={() => setOpen(true)}
            >
              <SearchIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Search · ⌘K</TooltipContent>
        </Tooltip>
        <ThemeMenu />
      </div>
    </header>
  );
}
