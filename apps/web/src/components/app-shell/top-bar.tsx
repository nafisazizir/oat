'use client';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@oat/ui/components/breadcrumb';
import { Button } from '@oat/ui/components/button';
import { Kbd } from '@oat/ui/components/kbd';
import { Separator } from '@oat/ui/components/separator';
import { SidebarTrigger } from '@oat/ui/components/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@oat/ui/components/tooltip';
import { IconSearch } from '@tabler/icons-react';
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
    <Breadcrumb aria-label="Breadcrumb" className="min-w-0">
      <BreadcrumbList className="flex-nowrap gap-1.5 sm:gap-1.5">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          // On small screens only the current page shows.
          return (
            <Fragment key={`${index}-${crumb.label}`}>
              {index > 0 && <BreadcrumbSeparator className="hidden text-gray-700 sm:block" />}
              <BreadcrumbItem className={last ? 'min-w-0' : 'hidden shrink-0 sm:inline-flex'}>
                {last ? (
                  <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                ) : crumb.href ? (
                  <BreadcrumbLink
                    render={<Link href={crumb.href as Route} />}
                    className="rounded-sm focus-visible:ring-3 focus-visible:ring-gray-600/50 focus-visible:outline-none"
                  >
                    {crumb.label}
                  </BreadcrumbLink>
                ) : (
                  <span>{crumb.label}</span>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/** Sticky bar above the content: sidebar toggle, breadcrumbs, search and theme. */
export function TopBar() {
  const pathname = usePathname();
  const { setOpen } = useCommandMenu();
  const shell = useShellData();

  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b border-gray-alpha-400 bg-background-100 px-3">
      <Tooltip>
        <TooltipTrigger render={<SidebarTrigger data-testid="sidebar-trigger" />}></TooltipTrigger>
        <TooltipContent>
          Toggle sidebar <Kbd>⌘B</Kbd>
        </TooltipContent>
      </Tooltip>
      <Separator
        orientation="vertical"
        className="me-1 data-vertical:h-4 data-vertical:self-center"
      />
      <Breadcrumbs crumbs={breadcrumbsFor(shell, pathname)} />
      <div className="ms-auto flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Search"
                onClick={() => setOpen(true)}
              />
            }
          >
            <IconSearch />
          </TooltipTrigger>
          <TooltipContent>
            Search <Kbd>⌘K</Kbd>
          </TooltipContent>
        </Tooltip>
        <ThemeMenu />
      </div>
    </header>
  );
}
