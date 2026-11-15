// markdown-it-mark ships no types: `==text==` → mark_open / mark_close tokens.
declare module 'markdown-it-mark' {
  import type { MarkdownIt } from 'markdown-it';

  const markPlugin: (md: MarkdownIt) => void;
  export default markPlugin;
}
