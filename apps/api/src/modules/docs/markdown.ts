/**
 * Markdown to a typed block tree.
 *
 * Deliberately produces structured data rather than HTML. The documentation is
 * rendered by React components that map one block type to one component, so
 * there is no `dangerouslySetInnerHTML` anywhere in the application and no path
 * by which a document could inject markup. Adding a markdown-to-HTML library
 * would have meant sanitising its output and trusting the sanitiser; this way
 * there is nothing to sanitise.
 *
 * It is not a general-purpose parser and does not try to be. It covers exactly
 * what the documentation in `docs/` actually uses - headings, paragraphs,
 * lists (one level of nesting), GFM tables, fenced code, block quotes, rules,
 * and inline emphasis, code, links and strikethrough. A construct outside that
 * set degrades to a paragraph rather than being dropped, so nothing ever
 * silently disappears from a document.
 */

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'strong'; value: string }
  | { type: 'em'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strike'; value: string }
  | { type: 'link'; value: string; href: string; external: boolean };

export interface ListItem {
  content: InlineNode[];
  /** One level of nesting is enough for this corpus, and all it uses. */
  children: ListItem[];
}

export type DocBlock =
  | { type: 'heading'; level: number; text: string; slug: string; content: InlineNode[] }
  | { type: 'paragraph'; content: InlineNode[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'table'; head: InlineNode[][]; rows: InlineNode[][][]; align: Array<'left' | 'right' | 'center'> }
  | { type: 'code'; language: string | null; value: string }
  | { type: 'quote'; blocks: DocBlock[] }
  | { type: 'rule' };

/** GitHub's heading anchor rules, which the documents' own links assume. */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

const INLINE_PATTERN =
  /(\[[^\]]+\]\([^)]+\))|(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)/;

/**
 * Splits a line into inline nodes.
 *
 * Code spans win over everything else: a backtick run is taken whole, so
 * `**not bold**` inside one stays literal. That matters here because the
 * documentation quotes markdown and shell syntax constantly.
 */
export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let rest = text;

  while (rest.length > 0) {
    const match = INLINE_PATTERN.exec(rest);
    if (!match || match.index === undefined) {
      nodes.push({ type: 'text', value: rest });
      break;
    }

    if (match.index > 0) {
      nodes.push({ type: 'text', value: rest.slice(0, match.index) });
    }

    const token = match[0];

    if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkMatch) {
        const href = linkMatch[2] ?? '';
        nodes.push({
          type: 'link',
          value: linkMatch[1] ?? '',
          href,
          external: /^https?:\/\//i.test(href),
        });
      } else {
        nodes.push({ type: 'text', value: token });
      }
    } else if (token.startsWith('`')) {
      nodes.push({ type: 'code', value: token.slice(1, -1) });
    } else if (token.startsWith('**')) {
      nodes.push({ type: 'strong', value: token.slice(2, -2) });
    } else if (token.startsWith('~~')) {
      nodes.push({ type: 'strike', value: token.slice(2, -2) });
    } else {
      nodes.push({ type: 'em', value: token.slice(1, -1) });
    }

    rest = rest.slice(match.index + token.length);
  }

  return nodes.filter((node) => node.type !== 'text' || node.value !== '');
}

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

const isTableDivider = (line: string): boolean =>
  /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');

function alignmentOf(cell: string): 'left' | 'right' | 'center' {
  const trimmed = cell.trim();
  if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
  if (trimmed.endsWith(':')) return 'right';
  return 'left';
}

/** Parses a document body into blocks. */
export function parseMarkdown(source: string): DocBlock[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: DocBlock[] = [];
  let index = 0;

  /**
   * Anchors must be unique within a document.
   *
   * Two headings with the same words - "Offboarding" appears twice in the
   * administrator manual - would otherwise produce two elements sharing one id,
   * so a link to the second would silently land on the first. The suffix
   * follows the rule the documents' own links already assume: the first
   * occurrence keeps the plain slug, and only later ones are numbered.
   */
  const usedSlugs = new Map<string, number>();
  const uniqueSlug = (base: string): string => {
    const seen = usedSlugs.get(base) ?? 0;
    usedSlugs.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen}`;
  };

  const flushParagraph = (buffer: string[]) => {
    if (buffer.length === 0) return;
    blocks.push({ type: 'paragraph', content: parseInline(buffer.join(' ').trim()) });
    buffer.length = 0;
  };

  const paragraph: string[] = [];

  while (index < lines.length) {
    const line = lines[index] ?? '';

    // --- fenced code ---------------------------------------------------------
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      flushParagraph(paragraph);
      const language = (fence[1] ?? '').trim() || null;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // closing fence
      blocks.push({ type: 'code', language, value: body.join('\n') });
      continue;
    }

    // --- blank ---------------------------------------------------------------
    if (line.trim() === '') {
      flushParagraph(paragraph);
      index += 1;
      continue;
    }

    // --- horizontal rule -----------------------------------------------------
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph(paragraph);
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    // --- heading -------------------------------------------------------------
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      const text = (heading[2] ?? '').trim().replace(/\s+#+\s*$/, '');
      blocks.push({
        type: 'heading',
        level: (heading[1] ?? '#').length,
        text: text.replace(/[*`~]/g, ''),
        slug: uniqueSlug(headingSlug(text.replace(/[*`~[\]()]/g, ''))),
        content: parseInline(text),
      });
      index += 1;
      continue;
    }

    // --- table ---------------------------------------------------------------
    if (line.trim().startsWith('|') && isTableDivider(lines[index + 1] ?? '')) {
      flushParagraph(paragraph);
      const head = splitRow(line);
      const align = splitRow(lines[index + 1] ?? '').map(alignmentOf);
      index += 2;

      const rows: InlineNode[][][] = [];
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('|')) {
        rows.push(splitRow(lines[index] ?? '').map(parseInline));
        index += 1;
      }

      blocks.push({ type: 'table', head: head.map(parseInline), rows, align });
      continue;
    }

    // --- block quote ---------------------------------------------------------
    if (/^\s*>/.test(line)) {
      flushParagraph(paragraph);
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) {
        quoted.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', blocks: parseMarkdown(quoted.join('\n')) });
      continue;
    }

    // --- list ----------------------------------------------------------------
    const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line);
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph(paragraph);
      const ordered = numbered !== null;
      const start = ordered ? Number(numbered?.[2] ?? '1') : 1;
      const items: ListItem[] = [];

      while (index < lines.length) {
        const current = lines[index] ?? '';
        const itemMatch = ordered
          ? /^(\s*)(\d+)[.)]\s+(.*)$/.exec(current)
          : /^(\s*)([-*+])\s+(.*)$/.exec(current);

        if (!itemMatch) {
          // A wrapped continuation line belongs to the item above it.
          if (current.trim() !== '' && /^\s+\S/.test(current) && items.length > 0) {
            const target = items[items.length - 1];
            if (target) {
              const last = target.children.length > 0
                ? target.children[target.children.length - 1]
                : target;
              if (last) {
                last.content = parseInline(
                  `${last.content.map(inlineToText).join('')} ${current.trim()}`,
                );
              }
            }
            index += 1;
            continue;
          }
          break;
        }

        const indent = (itemMatch[1] ?? '').length;
        const content = parseInline(itemMatch[3] ?? '');

        if (indent >= 2 && items.length > 0) {
          items[items.length - 1]?.children.push({ content, children: [] });
        } else {
          items.push({ content, children: [] });
        }
        index += 1;
      }

      blocks.push({ type: 'list', ordered, start, items });
      continue;
    }

    // --- ordinary text -------------------------------------------------------
    paragraph.push(line.trim());
    index += 1;
  }

  flushParagraph(paragraph);
  return blocks;
}

/** Flattens inline nodes back to plain text, for search and continuations. */
export function inlineToText(node: InlineNode): string {
  return node.value;
}

/** The plain text of a document, for search indexing. */
export function blocksToText(blocks: readonly DocBlock[]): string {
  const parts: string[] = [];

  const walk = (block: DocBlock) => {
    switch (block.type) {
      case 'heading':
      case 'paragraph':
        parts.push(block.content.map(inlineToText).join(''));
        break;
      case 'list':
        for (const item of block.items) {
          parts.push(item.content.map(inlineToText).join(''));
          for (const child of item.children) {
            parts.push(child.content.map(inlineToText).join(''));
          }
        }
        break;
      case 'table':
        parts.push(block.head.map((cell) => cell.map(inlineToText).join('')).join(' '));
        for (const row of block.rows) {
          parts.push(row.map((cell) => cell.map(inlineToText).join('')).join(' '));
        }
        break;
      case 'code':
        parts.push(block.value);
        break;
      case 'quote':
        block.blocks.forEach(walk);
        break;
      default:
        break;
    }
  };

  blocks.forEach(walk);
  return parts.join('\n');
}

/** The first paragraph, for a summary line on the documentation home. */
export function firstParagraph(blocks: readonly DocBlock[]): string {
  for (const block of blocks) {
    if (block.type === 'paragraph') {
      const text = block.content.map(inlineToText).join('').trim();
      if (text.length > 0) return text;
    }
  }
  return '';
}
