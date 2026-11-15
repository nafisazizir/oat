import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import type { ReactNode } from 'react';

import { Tabs, TabsList, TabsTrigger } from '@oat/ui/components/tabs';

import { ComponentGallery } from './sections/components.tsx';
import { MeetingPreview } from './sections/meeting-preview.tsx';
import { ColourTokens, ShapeTokens, TypeScale } from './sections/tokens.tsx';

function ThemeSwitch() {
  const { theme, setTheme, forcedTheme } = useTheme();
  return (
    <Tabs value={forcedTheme ?? theme ?? 'system'} onValueChange={setTheme}>
      <TabsList>
        <TabsTrigger value="light" aria-label="Light">
          <SunIcon />
        </TabsTrigger>
        <TabsTrigger value="dark" aria-label="Dark">
          <MoonIcon />
        </TabsTrigger>
        <TabsTrigger value="system" aria-label="System">
          <MonitorIcon />
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function Section({
  id,
  title,
  lede,
  children,
}: {
  id: string;
  title: string;
  lede: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-20 flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-medium">{title}</h2>
        <p className="max-w-content text-base text-muted-foreground">{lede}</p>
      </div>
      {children}
    </section>
  );
}

const nav = [
  ['context', 'In context'],
  ['colour', 'Colour'],
  ['type', 'Type'],
  ['shape', 'Shape & motion'],
  ['components', 'Components'],
] as const;

export function App({ staticOverlays }: { staticOverlays: boolean }) {
  return (
    <div className="min-h-svh bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-8">
          <span className="font-heading text-xl font-semibold tracking-tight">
            oat<span className="text-primary">.</span>
            <span className="ml-1.5 font-sans text-sm font-normal text-muted-foreground">ui</span>
          </span>
          <nav className="hidden items-center gap-4 text-muted-foreground md:flex">
            {nav.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                className="transition-colors duration-fast hover:text-foreground"
              >
                {label}
              </a>
            ))}
          </nav>
          <div className="ml-auto">
            <ThemeSwitch />
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-16 px-8 pt-12 pb-40">
        <div className="flex flex-col gap-3">
          <h1 className="text-4xl font-medium">A calm, warm place to think.</h1>
          <p className="max-w-content text-lg text-muted-foreground">
            Oat paper, warm ink and one confident accent. Every value below is a token in{' '}
            <code className="font-mono text-sm text-foreground">tokens.css</code> — change the
            token, and every component follows, in both themes.
          </p>
        </div>

        <Section
          id="context"
          title="In context"
          lede="Sidebar, an enhanced note where your words stay full-strength ink and AI additions are softer, and a transcript with distinct voices for you and them."
        >
          <MeetingPreview />
        </Section>

        <Section
          id="colour"
          title="Colour"
          lede="Warm, low-chroma neutrals for surfaces; a single ink accent for action and focus; status colours used sparingly."
        >
          <ColourTokens />
        </Section>

        <Section
          id="type"
          title="Type"
          lede="Newsreader for titles and headings gives the page its paper feel; Instrument Sans keeps the dense UI crisp at 13px."
        >
          <TypeScale />
        </Section>

        <Section
          id="shape"
          title="Shape & motion"
          lede="Soft corners from a single radius, low diffuse shadows, a 4px spacing grid and short, gentle easing."
        >
          <ShapeTokens />
        </Section>

        <Section
          id="components"
          title="Components"
          lede="shadcn/ui (Radix) components, restyled through tokens only."
        >
          <ComponentGallery staticOverlays={staticOverlays} />
        </Section>
      </main>
    </div>
  );
}
