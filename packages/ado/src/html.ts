import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

export interface CleanDocument {
  readonly text: string;
  readonly links: readonly { label: string; href: string }[];
}

export function normalizeHtml(html: string): CleanDocument {
  if (Buffer.byteLength(html, 'utf8') > 262_144) throw new Error('HTML exceeds normalization limit');
  const links: { label: string; href: string }[] = [];
  const ignored = new Set(['script', 'style', 'template', 'iframe', 'object', 'svg', 'img', 'head']);
  const blocks = new Set(['p', 'div', 'section', 'article', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table']);
  function visit(node: DefaultTreeAdapterMap['node'], depth: number): string {
    if (depth > 100) throw new Error('HTML nesting exceeds normalization limit');
    if ('value' in node) return node.value.replace(/\s+/g, ' ');
    if (!('childNodes' in node)) return '';
    const tag = 'tagName' in node ? node.tagName : '';
    if (ignored.has(tag)) return ' ';
    if (tag === 'br' || tag === 'hr') return '\n';
    const body = node.childNodes.map(child => visit(child, depth + 1)).join(' ');
    if (tag === 'a' && 'attrs' in node) {
      const href = node.attrs.find(attribute => attribute.name === 'href')?.value;
      if (href) {
        try {
          const url = new URL(href);
          if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
            const label = body.trim();
            links.push({ label, href: url.href });
            return `${label} (${url.href})`;
          }
        } catch { return body; }
      }
    }
    if (tag === 'li') {
      const parent = 'parentNode' in node ? node.parentNode : null;
      let marker = '-';
      if (parent && 'tagName' in parent && parent.tagName === 'ol') {
        const start = Number(parent.attrs.find(attribute => attribute.name === 'start')?.value ?? 1);
        const siblings = parent.childNodes.filter(child => 'tagName' in child && child.tagName === 'li');
        marker = `${(Number.isSafeInteger(start) ? start : 1) + siblings.findIndex(sibling => sibling === node)}.`;
      }
      return `\n${marker} ${body.trim()}\n`;
    }
    if (tag === 'td' || tag === 'th') return ` ${body.trim()} |`;
    if (tag === 'tr') return `\n|${body}\n`;
    return blocks.has(tag) ? `\n${body}\n` : body;
  }
  const text = visit(parseFragment(html), 0).replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, links };
}
