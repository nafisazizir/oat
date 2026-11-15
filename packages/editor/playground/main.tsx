import type { Editor, JSONContent } from '@tiptap/core';
import { MoonIcon, SunIcon } from 'lucide-react';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { Switch } from '@oat/ui/components/switch';

import { OatEditor } from '../src/react/index.ts';
import { EMPTY_DOC, SAMPLE_DOC, searchPeople } from './sample.ts';
import './playground.css';

declare global {
  interface Window {
    /** Exposed for Playwright. */
    __oatEditor?: Editor;
  }
}

const params = new URLSearchParams(window.location.search);
const initialTheme =
  params.get('theme') ??
  (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.classList.toggle('dark', initialTheme === 'dark');

function App() {
  const [doc, setDoc] = useState<JSONContent>(
    params.get('doc') === 'empty' ? EMPTY_DOC : SAMPLE_DOC,
  );
  const [editable, setEditable] = useState(params.get('readonly') !== '1');
  const [dark, setDark] = useState(initialTheme === 'dark');

  const toggleTheme = () => {
    document.documentElement.classList.toggle('dark', !dark);
    setDark(!dark);
  };

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <span className="text-sm font-medium text-muted-foreground">@oat/editor playground</span>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={editable} onCheckedChange={setEditable} aria-label="Editable" />
            Editable
          </label>
          <Button variant="ghost" size="icon-sm" aria-label="Toggle theme" onClick={toggleTheme}>
            {dark ? <SunIcon /> : <MoonIcon />}
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-content px-6 py-10">
        <h1 className="text-3xl font-semibold">Weekly onboarding sync</h1>
        <div className="mt-3 mb-8 flex items-center gap-2 text-xs text-muted-foreground">
          <span>Thu 14 Nov · 10:00</span>
          <span aria-hidden>·</span>
          <Badge variant="outline" className="gap-1.5">
            <span className="size-2 rounded-full bg-my-text" aria-hidden />
            My notes
          </Badge>
          <Badge variant="outline" className="gap-1.5">
            <span className="size-2 rounded-full bg-ai-text" aria-hidden />
            AI-added
          </Badge>
        </div>

        <OatEditor
          value={doc}
          onChange={setDoc}
          editable={editable}
          onMentionQuery={searchPeople}
          autoFocus={params.get('doc') === 'empty'}
          onReady={(editor) => {
            window.__oatEditor = editor;
          }}
        />

        <details className="mt-12 rounded-lg border bg-card text-sm">
          <summary className="cursor-pointer px-4 py-2 text-muted-foreground">
            Document JSON
          </summary>
          <pre className="max-h-96 overflow-auto border-t px-4 py-3 font-mono text-xs">
            {JSON.stringify(doc, null, 2)}
          </pre>
        </details>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
