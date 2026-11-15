/**
 * Citation markers in assistant answers (SPEC §7 grounding, 6.2).
 *
 * The model cites with `[[seg:<segment id>]]` (a transcript line) or `[[block:<block id>]]` (a note block).
 * The server keeps a marker only if its id was handed to the model by a tool in this thread (or, in a
 * document chat, appears in the meeting context: block ids, or transcript refs like `s12`, which are rewritten
 * to the real segment id). Everything else is stripped before the text reaches the client or the database,
 * so an answer can never point at something the user wasn't shown — or that doesn't exist.
 *
 * {@link CitationRegistry} collects allowed ids from tool output (any string in it: `[[seg:…]]` /
 * `[[block:…]]` markers, and `blockIds` arrays our tools add); tool output defuses `[[` and `<!--` inside
 * user content, so content can't smuggle a marker in. {@link CitationFilter} rewrites streamed text,
 * holding back a partial `[[…` until it is complete.
 */
import type { TextStreamPart, ToolSet } from 'ai';

export type CitationKind = 'seg' | 'block';

export interface Citation {
  kind: CitationKind;
  id: string;
}

/** A well-formed marker; ids are the characters block ids may use (`@oat/editor` marker-safe ids). */
export const CITATION_MARKER = /\[\[(seg|block):([\w.:-]{1,128})\]\]/g;

const MARKER_SAFE_ID = /^[\w.:-]{1,128}$/;

/** Output key whose string array lists citable block ids (set by our tools, e.g. `getDocument`). */
export const CITABLE_BLOCKS_KEY = 'blockIds';

/** Anything shaped like a citation, including sloppy spacing, so malformed ones get stripped too. */
const LOOSE_MARKER = /^\[\[\s*(seg|block)\s*:\s*([^\]]*?)\s*\]\]$/i;

/** Longest `[[…` held back while waiting for `]]`. */
const MAX_PENDING = 200;

export class CitationRegistry {
  readonly segments = new Set<string>();
  readonly blocks = new Set<string>();
  /** Transcript refs in a document chat's context (`s12`) → segment id. */
  readonly segmentRefs = new Map<string, string>();

  /**
   * Allows the ids a tool output (any shape) hands out: `[[seg|block:…]]` markers in any string (user content
   * in tool output has `[[` defused, so only our code produces them) and string arrays under a
   * {@link CITABLE_BLOCKS_KEY} key (object keys never come from user content). Never Markdown `<!-- id=… -->`
   * text: users can type that.
   */
  addFromOutput(value: unknown): void {
    const visit = (v: unknown, depth: number) => {
      if (depth > 12) return;
      if (typeof v === 'string') {
        for (const m of v.matchAll(CITATION_MARKER)) {
          (m[1] === 'seg' ? this.segments : this.blocks).add(m[2]!);
        }
      } else if (Array.isArray(v)) {
        for (const item of v) visit(item, depth + 1);
      } else if (v !== null && typeof v === 'object') {
        for (const [key, item] of Object.entries(v)) {
          if (key === CITABLE_BLOCKS_KEY && Array.isArray(item)) {
            for (const id of item) {
              if (typeof id === 'string' && MARKER_SAFE_ID.test(id)) this.blocks.add(id);
            }
          } else {
            visit(item, depth + 1);
          }
        }
      }
    };
    visit(value, 0);
  }

  /** The id to keep for a cited `(kind, id)`, or `undefined` when it must be stripped. */
  resolve(kind: CitationKind, id: string): string | undefined {
    if (kind === 'block') return this.blocks.has(id) ? id : undefined;
    if (this.segments.has(id)) return id;
    return this.segmentRefs.get(id);
  }
}

/** What the filter did, for `context_json` and evals. */
export class CitationStats {
  readonly kept: Citation[] = [];
  readonly dropped: string[] = [];
  #seen = new Set<string>();

  keep(c: Citation) {
    const key = `${c.kind}:${c.id}`;
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    this.kept.push(c);
  }

  drop(marker: string) {
    if (this.dropped.length < 50) this.dropped.push(marker.slice(0, 160));
  }
}

/** Rewrites text (streamed in pieces, per text part id): valid markers normalised, others removed. */
export class CitationFilter {
  #buffers = new Map<string, string>();

  constructor(
    readonly registry: CitationRegistry,
    readonly stats: CitationStats = new CitationStats(),
  ) {}

  /** A span matching {@link LOOSE_MARKER}: normalised when its id is allowed, else removed. */
  #marker(marker: string): string {
    const m = LOOSE_MARKER.exec(marker)!;
    const kind = m[1]!.toLowerCase() as CitationKind;
    const id = m[2]!;
    const resolved = MARKER_SAFE_ID.test(id) ? this.registry.resolve(kind, id) : undefined;
    if (resolved === undefined) {
      this.stats.drop(marker);
      return '';
    }
    this.stats.keep({ kind, id: resolved });
    return `[[${kind}:${resolved}]]`;
  }

  /** Feeds a piece of text part `id`; returns what can be emitted now. */
  push(id: string, text: string): string {
    let buf = (this.#buffers.get(id) ?? '') + text;
    let out = '';
    for (;;) {
      const open = buf.indexOf('[[');
      if (open === -1) {
        // A trailing "[" may become "[[" with the next piece.
        const hold = buf.endsWith('[') ? 1 : 0;
        out += buf.slice(0, buf.length - hold);
        buf = buf.slice(buf.length - hold);
        break;
      }
      out += buf.slice(0, open);
      buf = buf.slice(open);
      const close = buf.indexOf(']]');
      if (close === -1 && buf.length <= MAX_PENDING && !buf.includes('\n')) break; // wait for more text
      const span = close === -1 ? '' : buf.slice(0, close + 2);
      if (close !== -1 && LOOSE_MARKER.test(span)) {
        out += this.#marker(span);
        buf = buf.slice(close + 2);
        continue;
      }
      // Not a marker starting here: let only the first "[" through and rescan from the next character, so a
      // marker nested in the span ("[[[seg:x]]", "[[note [[seg:x]]") is still checked.
      out += '[';
      buf = buf.slice(1);
    }
    this.#buffers.set(id, buf);
    return out;
  }

  /** End of text part `id`: whatever was held back (an unfinished `[[…` is plain text). */
  flush(id: string): string {
    const rest = this.#buffers.get(id) ?? '';
    this.#buffers.delete(id);
    return rest;
  }
}

/** One-shot form of {@link CitationFilter}. */
export function filterCitations(
  text: string,
  registry: CitationRegistry,
  stats: CitationStats = new CitationStats(),
): string {
  const filter = new CitationFilter(registry, stats);
  return filter.push('t', text) + filter.flush('t');
}

/** Markers in a (filtered) answer, in order of first appearance. */
export function extractCitations(text: string): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const m of text.matchAll(CITATION_MARKER)) {
    const key = `${m[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: m[1] as CitationKind, id: m[2]! });
  }
  return out;
}

/**
 * `streamText` `experimental_transform`: registers ids from tool results as they stream by, and filters
 * every text delta before anything downstream (UI stream, `result.text`, persistence) sees it.
 */
export function citationTransform(filter: CitationFilter) {
  return <TOOLS extends ToolSet>() =>
    new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(part, controller) {
        if (part.type === 'tool-result') {
          filter.registry.addFromOutput((part as { output?: unknown }).output);
        } else if (part.type === 'text-delta') {
          const text = filter.push(part.id, part.text);
          if (text) controller.enqueue({ ...part, text });
          return;
        } else if (part.type === 'text-end') {
          const rest = filter.flush(part.id);
          if (rest) controller.enqueue({ type: 'text-delta', id: part.id, text: rest });
        }
        controller.enqueue(part);
      },
    });
}
