import type { JoinSnapshot } from '@oat/workspace-ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { WebJoinWorkspace } from './join-choices';

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), join: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@oat/workspace-ui', () => ({
  JoinWorkspace: (props: { email: string; initial: JoinSnapshot; onHome(): void }) => {
    router.join(props);
    return null;
  },
}));
afterEach(() => {
  vi.clearAllMocks();
});

it('supplies the signed-in snapshot and returns home with refreshed server data', () => {
  renderToStaticMarkup(
    <WebJoinWorkspace
      email="member@company.test"
      initial={{ member: true, choices: { invites: [], workspaces: [] } }}
    />,
  );
  const props = router.join.mock.lastCall![0] as {
    email: string;
    initial: JoinSnapshot;
    onHome(): void;
  };
  expect(props.email).toBe('member@company.test');
  expect(props.initial.member).toBe(true);
  props.onHome();
  expect(router.replace).toHaveBeenCalledExactlyOnceWith('/home');
  expect(router.refresh).toHaveBeenCalledOnce();
});
