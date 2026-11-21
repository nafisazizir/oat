/*
 * File names for exported notes (D-36). A note's title is free text typed by a user, and it becomes a
 * path inside an archive that another program unpacks — so a name must never be able to leave the folder
 * it is unpacked into ("zip slip"), never be hidden or reserved on a common file system, and never
 * collide with another note's.
 */

const MAX_BASE_LENGTH = 80;

/** Characters that are path syntax or not allowed in file names on Windows, macOS or Linux. */
const UNSAFE = /[\\/:*?"<>|\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Device names Windows refuses as a file's base name, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * A title as a safe file base name (no extension): path separators, control and invisible characters
 * and reserved punctuation become spaces; no leading dot (never hidden, never `.` or `..`), no trailing
 * dot or space; at most 80 characters; never empty.
 */
export function safeBaseName(title: string, fallback = 'Untitled'): string {
  const cleaned = title
    .normalize('NFC')
    .replace(UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim();
  const cut = [...cleaned]
    .slice(0, MAX_BASE_LENGTH)
    .join('')
    .replace(/[.\s]+$/, '');
  if (cut === '') return fallback;
  return RESERVED.test(cut) ? `_${cut}` : cut;
}

/**
 * Gives each title a file name that is safe and not taken yet: `Plan.md`, then `Plan (2).md`, … Names
 * that differ only by case count as the same (macOS and Windows file systems would merge them).
 */
export function createFileNamer(extension = '.md'): (title: string) => string {
  const used = new Set<string>();
  return (title) => {
    const base = safeBaseName(title);
    let name = `${base}${extension}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})${extension}`;
    used.add(name.toLowerCase());
    return name;
  };
}

/** A workspace name as part of the archive's own file name (ASCII, for the Content-Disposition header). */
export function asciiSlug(name: string, fallback = 'workspace'): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
    .toLowerCase();
  return slug || fallback;
}
