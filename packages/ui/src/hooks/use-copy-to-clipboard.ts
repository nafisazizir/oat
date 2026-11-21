'use client';

import * as React from 'react';

// Writes to the clipboard and reports a short-lived `isCopied` so a trigger
// can swap its icon. Falls back to a hidden textarea where the async
// Clipboard API is unavailable or blocked (http:// origins, older Safari).
function legacyCopy(value: string) {
  const textArea = document.createElement('textarea');
  textArea.value = value;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  textArea.style.pointerEvents = 'none';

  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  textArea.setSelectionRange(0, value.length);

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textArea.remove();
  }
}

export function useCopyToClipboard({
  timeout = 2000,
  onCopy,
}: { timeout?: number; onCopy?: () => void } = {}) {
  const [isCopied, setIsCopied] = React.useState(false);

  const copyToClipboard = async (value: string) => {
    if (typeof window === 'undefined' || !value) return false;

    const copied = await navigator.clipboard?.writeText(value).then(
      () => true,
      () => false,
    );
    if (!copied && !legacyCopy(value)) return false;

    setIsCopied(true);
    onCopy?.();
    if (timeout !== 0) setTimeout(() => setIsCopied(false), timeout);
    return true;
  };

  return { isCopied, copyToClipboard };
}
