/*
 * File names for exported notes (D-36). A note's title is free text typed by a user, and it becomes a
 * path inside an archive that another program unpacks — so a name must never be able to leave the folder
 * it is unpacked into ("zip slip"), never be hidden or reserved on a common file system, and never
 * collide with another note's.
 */

/**
 * Longest base name, in UTF-8 bytes. File systems limit a name to 255 **bytes** (APFS, ext4; NTFS counts
 * UTF-16 units, which is never more), so the cap is on bytes, with room left for the extension and a
 * " (1234)" duplicate suffix: 200 + 7 + 3 = 210 at most.
 */
export const MAX_BASE_BYTES = 200;

/** Characters that are path syntax or not allowed in file names on Windows, macOS or Linux. */
const UNSAFE = /[\\/:*?"<>|\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Device names Windows refuses as a file name — alone or followed by any extensions (`con`, `con.md`,
 * `con.notes.md`), so the test is on the part before the first dot.
 */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

const utf8 = new TextEncoder();

/** `text` cut to at most `maxBytes` of UTF-8, never in the middle of a character. */
function cutToBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (const char of text) {
    bytes += utf8.encode(char).length;
    if (bytes > maxBytes) break;
    out += char;
  }
  return out;
}

/**
 * A title as a safe file base name (no extension): path separators, control and invisible characters
 * and reserved punctuation become spaces; no leading dot (never hidden, never `.` or `..`), no trailing
 * dot or space; at most `MAX_BASE_BYTES` bytes; never empty; never a Windows device name.
 */
export function safeBaseName(title: string, fallback = 'Untitled'): string {
  const cleaned = title
    .normalize('NFC')
    .replace(UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim();
  const cut = cutToBytes(cleaned, MAX_BASE_BYTES).replace(/[.\s]+$/, '');
  if (cut === '') return fallback;
  return RESERVED.test(cut.split('.')[0]!.trim()) ? `_${cut}` : cut;
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
