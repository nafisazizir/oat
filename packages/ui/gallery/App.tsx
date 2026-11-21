import { IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-react';
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
          <IconSun />
        </TabsTrigger>
        <TabsTrigger value="dark" aria-label="Dark">
          <IconMoon />
        </TabsTrigger>
        <TabsTrigger value="system" aria-label="System">
          <IconDeviceDesktop />
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
        <h2 className="text-heading-24">{title}</h2>
        <p className="max-w-content text-copy-16 text-gray-900">{lede}</p>
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
    <div className="min-h-svh bg-background-100 text-copy-14 text-gray-1000">
      <header className="sticky top-0 z-10 border-b border-gray-alpha-400 bg-background-100">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-8">
          <span className="text-heading-20">
            oat<span className="text-gray-1000">.</span>
            <span className="ms-1.5 text-copy-14 text-gray-900">ui</span>
          </span>
          <nav className="hidden items-center gap-4 text-label-14 text-gray-900 md:flex">
            {nav.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                className="transition-colors duration-fast hover:text-gray-1000"
              >
                {label}
              </a>
            ))}
          </nav>
          <div className="ms-auto">
            <ThemeSwitch />
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-16 px-8 pt-12 pb-40">
        <div className="flex flex-col gap-3">
          <h1 className="text-heading-40">A calm, warm place to think.</h1>
          <p className="max-w-content text-copy-18 text-gray-900">
            Oat paper, warm ink and one confident accent. Every value below is a token in{' '}
            <code className="text-copy-13-mono text-gray-1000">tokens.css</code> — change the token,
            and every component follows, in both themes.
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
          lede="Newsreader for display titles, Inter for UI and copy, Geist Mono for code. Each role owns its size, weight, leading and tracking."
        >
          <TypeScale />
        </Section>

        <Section
          id="shape"
          title="Shape & motion"
          lede="Flat in-page surfaces, one material per floating surface, a shared radius and short, gentle easing."
        >
          <ShapeTokens />
        </Section>

        <Section
          id="components"
          title="Components"
          lede="Ziiz components built on Base UI, with ramp colors, type roles and Tabler icons."
        >
          <ComponentGallery staticOverlays={staticOverlays} />
        </Section>
      </main>
    </div>
  );
}
