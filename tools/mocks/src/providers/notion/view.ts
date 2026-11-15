/**
 * A plain HTML rendering of a mock Notion page (what the page `url` opens), so "Open in Notion" works
 * offline in dev and the e2e can look at what was sent. Deliberately unstyled beyond readability; this is
 * not Notion's look.
 */
import type { Json, RichText } from './store.ts';

const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function richText(items: unknown): string {
  return ((items as RichText[] | undefined) ?? [])
    .map((t) => {
      let html = escape(t.plain_text).replace(/\n/g, '<br>');
      const a = t.annotations;
      if (a.code) html = `<code>${html}</code>`;
      if (a.bold) html = `<strong>${html}</strong>`;
      if (a.italic) html = `<em>${html}</em>`;
      if (a.strikethrough) html = `<s>${html}</s>`;
      if (a.color.endsWith('_background')) html = `<mark>${html}</mark>`;
      if (t.href) html = `<a href="${escape(t.href)}">${html}</a>`;
      return html;
    })
    .join('');
}

const LIST_TAGS: Record<string, string> = { bulleted_list_item: 'ul', numbered_list_item: 'ol' };

function blocks(list: readonly Json[]): string {
  let out = '';
  let open: string | undefined;
  for (const block of list) {
    const type = String(block.type);
    const tag = LIST_TAGS[type];
    if (tag !== open) {
      if (open) out += `</${open}>`;
      if (tag) out += `<${tag}>`;
      open = tag;
    }
    out += one(block);
  }
  if (open) out += `</${open}>`;
  return out;
}

function one(block: Json): string {
  const type = String(block.type);
  const data = (block[type] ?? {}) as Json;
  const text = richText(data.rich_text);
  const kids =
    Array.isArray(block.children) && block.children.length ? blocks(block.children as Json[]) : '';
  const id = `data-block-type="${escape(type)}"`;
  switch (type) {
    case 'heading_1':
      return `<h2 ${id}>${text}</h2>`;
    case 'heading_2':
      return `<h3 ${id}>${text}</h3>`;
    case 'heading_3':
      return `<h4 ${id}>${text}</h4>`;
    case 'bulleted_list_item':
    case 'numbered_list_item':
      return `<li ${id}>${text}${kids}</li>`;
    case 'to_do':
      return `<div ${id}><input type="checkbox" disabled${data.checked ? ' checked' : ''}> ${text}${kids ? `<div class="kids">${kids}</div>` : ''}</div>`;
    case 'quote':
      return `<blockquote ${id}>${text}${kids}</blockquote>`;
    case 'code':
      return `<pre ${id} data-language="${escape(String(data.language ?? ''))}"><code>${text}</code></pre>`;
    case 'divider':
      return `<hr ${id}>`;
    case 'child_page':
      return `<p ${id}>📄 ${escape(String((data as { title?: string }).title ?? ''))}</p>`;
    case 'callout': {
      const icon = data.icon as { emoji?: string } | undefined;
      return `<aside ${id}><span>${escape(icon?.emoji ?? '')}</span> ${text}${kids}</aside>`;
    }
    default:
      return `<p ${id}>${text}</p>${kids ? `<div class="kids">${kids}</div>` : ''}`;
  }
}

function propertyValue(prop: Json): string {
  const type = String(prop.type);
  const v = prop[type];
  if (type === 'title' || type === 'rich_text') return richText(v);
  if (type === 'date') return v ? escape(String((v as { start: string }).start)) : '';
  if (type === 'url') return v ? `<a href="${escape(String(v))}">${escape(String(v))}</a>` : '';
  if (type === 'multi_select')
    return escape((v as { name: string }[]).map((o) => o.name).join(', '));
  return v === null || v === undefined ? '' : escape(JSON.stringify(v));
}

export function renderPageHtml(page: {
  title: string;
  icon: Json | null;
  archived: boolean;
  properties: Record<string, Json>;
  blocks: Json[];
  rows?: Array<{ title: string; url: string }>;
}): string {
  const icon = (page.icon as { emoji?: string } | null)?.emoji ?? '';
  const props = Object.entries(page.properties)
    .filter(([, p]) => p.type !== 'title')
    .map(([name, p]) => `<tr><th>${escape(name)}</th><td>${propertyValue(p)}</td></tr>`)
    .join('');
  const rows = page.rows
    ? `<ul>${page.rows.map((r) => `<li><a href="${escape(r.url)}">${escape(r.title || 'Untitled')}</a></li>`).join('')}</ul>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(page.title || 'Untitled')} · Notion mock</title>
<style>
body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#222;background:#fff}
.banner{font-size:12px;color:#666;border-bottom:1px solid #ddd;padding-bottom:.5rem;margin-bottom:1rem}
.archived{background:#fee;padding:.5rem;border-radius:6px}
table{border-collapse:collapse;margin-bottom:1rem;font-size:14px}th{text-align:left;color:#666;padding-right:1rem;font-weight:500}
blockquote{border-left:3px solid #ccc;margin:0;padding-left:1rem}
aside{background:#f4f4f2;border-radius:6px;padding:.75rem}
pre{background:#f6f6f6;padding:.75rem;border-radius:6px;overflow:auto}
.kids{margin-left:1.5rem}mark{background:#fdf2b3}
</style></head>
<body>
<div class="banner">Local Notion mock (tools/mocks) · not notion.so</div>
${page.archived ? '<p class="archived">This page is in the trash.</p>' : ''}
<h1>${escape(icon)} ${escape(page.title || 'Untitled')}</h1>
${props ? `<table>${props}</table>` : ''}
${rows}
<main>${blocks(page.blocks)}</main>
</body></html>`;
}
