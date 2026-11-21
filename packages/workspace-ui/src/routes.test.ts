import { describe, expect, it } from 'vitest';
import { hrefOf, inSection, routeOf, type AppRoute } from './routes';

describe('workspace routes', () => {
  const routes: AppRoute[] = [
    { view: 'home' },
    { view: 'document', id: 'a/b', query: { t: '10', seg: 'two words' } },
    { view: 'document', id: 'simple' },
    { view: 'templates' },
    { view: 'template', id: 'a b' },
    { view: 'template-new' },
    { view: 'tasks' },
    { view: 'assistant' },
    { view: 'assistant', threadId: 'a/b' },
    { view: 'search' },
    { view: 'search', q: '' },
    { view: 'search', q: 'hello & world' },
    { view: 'settings' },
    { view: 'settings', section: 'workspace/members' },
    { view: 'join' },
  ];
  it.each(routes)('round trips $view', (route) => {
    const url = new URL(hrefOf(route), 'https://oat.test');
    expect(routeOf(url.pathname, url.search)).toEqual(route);
  });
  it('defaults empty and unknown paths to home', () => {
    expect(routeOf('')).toEqual({ view: 'home' });
    expect(routeOf('/missing')).toEqual({ view: 'home' });
    expect(routeOf('/d')).toEqual({ view: 'home' });
  });
  it('keeps section boundaries', () => {
    expect(inSection('/templates/a', '/templates')).toBe(true);
    expect(inSection('/templates', '/templates')).toBe(true);
    expect(inSection('/templates-other', '/templates')).toBe(false);
  });
  it('does not crash on malformed URL encoding', () => {
    expect(routeOf('/d/%broken')).toEqual({ view: 'document', id: '%broken' });
  });
});
