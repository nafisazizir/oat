import { useCallback, useEffect, useState, type SetStateAction } from 'react';
import type { AppRoute } from '@oat/workspace-ui/routes';
import { bridge, call } from './bridge';
import { RouteHistory, historyShortcut, persistRoute, restoreRoute } from './route-history';

export function useRouteHistory(userId: string) {
  const [history] = useState(() => new RouteHistory(restoreRoute(userId)));
  const [snapshot, setSnapshot] = useState(() => history.snapshot);
  const commit = useCallback(() => {
    persistRoute(userId, history.route);
    setSnapshot(history.snapshot);
  }, [userId, history]);
  const navigate = useCallback(
    (next: AppRoute, options?: { replace?: boolean }) => {
      history.navigate(next, options);
      commit();
    },
    [history, commit],
  );
  const setRoute = useCallback(
    (next: SetStateAction<AppRoute>) => {
      navigate(typeof next === 'function' ? next(history.route) : next);
    },
    [history, navigate],
  );
  const move = useCallback(
    (direction: -1 | 1) => {
      history.move(direction);
      commit();
    },
    [history, commit],
  );
  useEffect(() => {
    let active = true;
    let revision = 0;
    const read = () => {
      const requested = ++revision;
      void call('navigation:get')
        .then((next) => {
          if (active && requested === revision && next) navigate(next);
        })
        .catch(() => {});
    };
    const unsubscribe = bridge().subscribe('navigation:changed', read);
    read();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [navigate]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const direction = historyShortcut(event);
      if (direction !== null) {
        event.preventDefault();
        move(direction);
      }
    };
    const mouse = (event: MouseEvent) => {
      if (event.defaultPrevented || (event.button !== 3 && event.button !== 4)) return;
      event.preventDefault();
      move(event.button === 3 ? -1 : 1);
    };
    const preventMouseNavigation = (event: MouseEvent) => {
      if (event.button === 3 || event.button === 4) event.preventDefault();
    };
    window.addEventListener('keydown', key);
    window.addEventListener('mousedown', mouse);
    window.addEventListener('auxclick', preventMouseNavigation);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('mousedown', mouse);
      window.removeEventListener('auxclick', preventMouseNavigation);
    };
  }, [move]);
  return { ...snapshot, navigate, setRoute };
}
