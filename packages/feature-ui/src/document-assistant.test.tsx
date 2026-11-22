// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AssistantToggleButton, DocumentAssistant } from './document-assistant';

vi.mock('./assistant-chat', () => ({
  AssistantChat: ({ scope, onClose }: { scope: { documentId: string }; onClose(): void }) => (
    <div data-testid="chat-scope">
      {scope.documentId}
      <button onClick={onClose}>Close assistant</button>
    </div>
  ),
}));
vi.mock('./open-document', async (original) => ({
  ...(await original<object>()),
  OpenDocumentAssistantIntegration: ({ children }: { children: ReactNode }) => children,
}));
beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: true,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});
afterEach(() => vi.unstubAllGlobals());
function note(available = true, anchored = false) {
  return (
    <DocumentAssistant
      documentId="note-1"
      workspaceId="w"
      available={available}
      transcript={null}
      focus={{}}
    >
      <p>My notes</p>
      {anchored && (
        <footer>
          <AssistantToggleButton />
        </footer>
      )}
    </DocumentAssistant>
  );
}
it('opens the shared document-scoped panel, remembers wide state and closes with focus return', () => {
  render(note());
  fireEvent.click(screen.getByTestId('assistant-toggle'));
  expect(screen.getByTestId('chat-scope').textContent).toContain('note-1');
  expect(window.localStorage.getItem('oat.assistant.panel')).toBe('1');
  fireEvent.click(screen.getByRole('button', { name: 'Close assistant' }));
  expect(screen.queryByTestId('chat-scope')).toBeNull();
  expect(window.localStorage.getItem('oat.assistant.panel')).toBe('0');
});
it('ignores shifted/repeated J and toggles the assistant with Cmd/Ctrl+J', () => {
  render(note());
  fireEvent.keyDown(window, { key: 'j', ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(window, { key: 'j', ctrlKey: true, repeat: true });
  expect(screen.queryByTestId('chat-scope')).toBeNull();
  fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
  expect(screen.getByTestId('chat-scope')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'j', metaKey: true });
  expect(screen.queryByTestId('chat-scope')).toBeNull();
});
it('renders a single anchored toggle for a native note toolbar', () => {
  render(note(true, true));
  expect(screen.getAllByTestId('assistant-toggle')).toHaveLength(1);
  expect(screen.getByTestId('assistant-toggle').closest('footer')).toBeTruthy();
});
it('keeps unavailable notes visible without an assistant control or shortcut', () => {
  render(note(false));
  expect(screen.getByText('My notes')).toBeTruthy();
  expect(screen.queryByTestId('assistant-toggle')).toBeNull();
  fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
  expect(screen.queryByTestId('chat-scope')).toBeNull();
});
