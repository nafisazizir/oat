'use client';

import { useEffect } from 'react';

export function usePanelEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (
        document.querySelector(
          '[role="dialog"][data-open], [role="alertdialog"][data-open], [role="menu"], [role="listbox"]',
        )
      )
        return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open, onClose]);
}
