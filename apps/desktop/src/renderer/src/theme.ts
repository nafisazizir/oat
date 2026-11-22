export function applyDesktopTheme() {
  const theme = localStorage.getItem('oat.theme');
  document.documentElement.classList.toggle(
    'dark',
    theme === 'dark' ||
      (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches),
  );
}

export function setDesktopTheme(theme: 'light' | 'dark' | 'system') {
  localStorage.setItem('oat.theme', theme);
  applyDesktopTheme();
}
