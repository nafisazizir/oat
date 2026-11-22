// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FeaturePageHeader } from './page-header';

describe('shared feature page header', () => {
  it.each(['tasks', 'search'] as const)('renders the %s title and workspace subtitle', (kind) => {
    render(<FeaturePageHeader kind={kind} workspaceName="Lakeside" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      kind === 'tasks' ? 'My tasks' : 'Search',
    );
    expect(
      screen.getByText(
        kind === 'tasks'
          ? 'Action items from meeting notes in Lakeside.'
          : 'Notes and transcripts in Lakeside.',
      ),
    ).toBeTruthy();
  });
  it('handles an empty workspace label', () => {
    render(<FeaturePageHeader kind="tasks" workspaceName=" " />);
    expect(screen.getByText('Action items from meeting notes in this workspace.')).toBeTruthy();
  });
});
