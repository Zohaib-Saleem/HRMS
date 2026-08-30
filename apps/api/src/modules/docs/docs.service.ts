import { statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Permission } from '@hrms/shared';
import { NotFoundError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import {
  DOC_BY_FILE,
  DOC_BY_SLUG,
  DOC_ENTRIES,
  type DocEntry,
} from './catalogue.js';
import {
  blocksToText,
  firstParagraph,
  parseMarkdown,
  type DocBlock,
  type InlineNode,
} from './markdown.js';

/**
 * Reading the documentation off disk.
 *
 * The files in `docs/` are the source of truth and are neither copied nor
 * bundled: editing one changes what the application serves on the next request,
 * which is the property that keeps the documentation maintainable by the people
 * who write it rather than by whoever last touched the frontend.
 *
 * Parsed documents are cached in memory and invalidated by the file's own
 * modification time, so a running server picks up an edit without a restart and
 * without re-parsing three hundred kilobytes on every request.
 */

/**
 * Where `docs/` lives.
 *
 * Walked up from this module rather than assumed from the working directory:
 * the API is started from the repository root in development and from its own
 * folder in production, and a relative path would be right in exactly one of
 * those.
 */
/**
 * A file that only the real documentation directory contains.
 *
 * Checked because "a directory named docs" is not specific enough: this module
 * itself lives in `src/modules/docs`, and walking up from it finds that one
 * first. Requiring a document that is actually in the catalogue means the walk
 * cannot stop at a folder that merely shares the name.
 */
const DOCS_SENTINEL = 'HRMS-DOCUMENTATION-INDEX.md';

function findDocsRoot(): string | null {
  let current = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(current, 'docs');
    try {
      // Synchronous on purpose: this runs once, at first use, and the answer is
      // needed before anything can be served.
      if (
        statSync(candidate).isDirectory() &&
        statSync(join(candidate, DOCS_SENTINEL)).isFile()
      ) {
        return candidate;
      }
    } catch {
      // Not here; keep walking up.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

let docsRoot: string | null | undefined;

function resolveDocsRoot(): string {
  if (docsRoot === undefined) {
    docsRoot = findDocsRoot();
    if (docsRoot === null) {
      logger.error(
        { event: 'DOCS_ROOT_MISSING' },
        'documentation directory not found; the help centre will report every document as missing',
      );
    } else {
      logger.info({ event: 'DOCS_ROOT', path: docsRoot }, 'documentation directory located');
    }
  }
  if (docsRoot === null) throw new NotFoundError('Documentation');
  return docsRoot;
}

interface CachedDoc {
  mtimeMs: number;
  blocks: DocBlock[];
  text: string;
  summary: string;
  headings: Array<{ level: number; text: string; slug: string }>;
}

const cache = new Map<string, CachedDoc>();

/**
 * Loads and parses one catalogued document.
 *
 * Takes a `DocEntry`, never a path or a slug from a request. The only way to
 * reach this function is to have already found an entry in the catalogue, so a
 * caller cannot ask for a file that is not in it.
 */
async function loadEntry(entry: DocEntry): Promise<CachedDoc> {
  const root = resolveDocsRoot();
  const path = resolve(root, entry.file);

  // Belt and braces. The filename comes from the catalogue and cannot contain a
  // traversal, but a mistyped entry should fail closed rather than read
  // something outside the documentation directory.
  if (path !== root && !path.startsWith(root + sep)) {
    logger.error(
      { event: 'DOCS_PATH_ESCAPE', slug: entry.slug },
      'catalogue entry resolves outside the documentation directory',
    );
    throw new NotFoundError('Document');
  }

  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    throw new NotFoundError('Document');
  }

  const cached = cache.get(entry.slug);
  if (cached && cached.mtimeMs === mtimeMs) return cached;

  const source = await readFile(path, 'utf8');
  const blocks = parseMarkdown(source);

  const parsed: CachedDoc = {
    mtimeMs,
    blocks,
    text: blocksToText(blocks),
    summary: firstParagraph(blocks),
    headings: blocks
      .filter((block): block is Extract<DocBlock, { type: 'heading' }> => block.type === 'heading')
      .filter((block) => block.level >= 2 && block.level <= 3)
      .map((block) => ({ level: block.level, text: block.text, slug: block.slug })),
  };

  cache.set(entry.slug, parsed);
  return parsed;
}

/** Whether a caller may read a given document. */
export function canRead(entry: DocEntry, permissions: ReadonlySet<Permission>): boolean {
  return entry.permission === undefined || permissions.has(entry.permission);
}

/** The catalogue, narrowed to what this caller may actually open. */
export function visibleEntries(permissions: ReadonlySet<Permission>): DocEntry[] {
  return DOC_ENTRIES.filter((entry) => canRead(entry, permissions));
}

/**
 * Rewrites links between documents into in-application routes.
 *
 * `HRMS-ADMIN-MANUAL.md#12-known-limitations` becomes
 * `/help/admin-manual#12-known-limitations`. A link to a file that is not in
 * the catalogue, or one the reader may not open, is flattened to plain text
 * rather than left as a dead link into nothing.
 */
function rewriteLinks(
  nodes: readonly InlineNode[],
  permissions: ReadonlySet<Permission>,
): InlineNode[] {
  return nodes.map((node) => {
    if (node.type !== 'link' || node.external) return node;

    const [file, anchor] = node.href.split('#');

    // A bare anchor stays within the document being read.
    if (!file) return node;

    const target = DOC_BY_FILE.get(file.replace(/^\.\//, '').toLowerCase());
    if (!target || !canRead(target, permissions)) {
      return { type: 'text', value: node.value };
    }

    return {
      ...node,
      href: `/help/${target.slug}${anchor ? `#${anchor}` : ''}`,
    };
  });
}

function rewriteBlocks(
  blocks: readonly DocBlock[],
  permissions: ReadonlySet<Permission>,
): DocBlock[] {
  return blocks.map((block) => {
    switch (block.type) {
      case 'heading':
        return { ...block, content: rewriteLinks(block.content, permissions) };
      case 'paragraph':
        return { ...block, content: rewriteLinks(block.content, permissions) };
      case 'list':
        return {
          ...block,
          items: block.items.map((item) => ({
            content: rewriteLinks(item.content, permissions),
            children: item.children.map((child) => ({
              content: rewriteLinks(child.content, permissions),
              children: [],
            })),
          })),
        };
      case 'table':
        return {
          ...block,
          head: block.head.map((cell) => rewriteLinks(cell, permissions)),
          rows: block.rows.map((row) => row.map((cell) => rewriteLinks(cell, permissions))),
        };
      case 'quote':
        return { ...block, blocks: rewriteBlocks(block.blocks, permissions) };
      default:
        return block;
    }
  });
}

export interface LoadedDoc {
  entry: DocEntry;
  blocks: DocBlock[];
  headings: Array<{ level: number; text: string; slug: string }>;
  summary: string;
}

/**
 * One document, if the caller may read it.
 *
 * An unknown slug and a forbidden slug both raise the same not-found, so the
 * catalogue cannot be enumerated by an employee probing for administrator
 * documents.
 */
export async function loadDocument(
  slug: string,
  permissions: ReadonlySet<Permission>,
): Promise<LoadedDoc> {
  const entry = DOC_BY_SLUG.get(slug);
  if (!entry || !canRead(entry, permissions)) throw new NotFoundError('Document');

  const parsed = await loadEntry(entry);
  return {
    entry,
    blocks: rewriteBlocks(parsed.blocks, permissions),
    headings: parsed.headings,
    summary: parsed.summary,
  };
}

/** Summary line for a card, without shipping the whole document. */
export async function summaryFor(entry: DocEntry): Promise<string> {
  try {
    const parsed = await loadEntry(entry);
    return parsed.summary || entry.summary;
  } catch {
    return entry.summary;
  }
}

export interface SearchHit {
  slug: string;
  title: string;
  category: string;
  /** Matching passages, with the term in context. */
  matches: Array<{ heading: string | null; anchor: string | null; excerpt: string }>;
  score: number;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Searches the documents the caller may read.
 *
 * A plain scan rather than an index: sixteen documents totalling a few hundred
 * kilobytes, already parsed and cached, is far below the point where an index
 * would earn its complexity. Results carry the heading each match sits under so
 * the reader can be taken to the right part of a long page rather than the top.
 */
export async function searchDocs(
  term: string,
  permissions: ReadonlySet<Permission>,
): Promise<SearchHit[]> {
  const needle = term.trim();
  if (needle.length < 2) return [];

  const pattern = new RegExp(escapeRegExp(needle), 'ig');
  const hits: SearchHit[] = [];

  for (const entry of visibleEntries(permissions)) {
    let parsed: CachedDoc;
    try {
      parsed = await loadEntry(entry);
    } catch {
      continue;
    }

    const matches: SearchHit['matches'] = [];
    let score = 0;

    // The title matching is worth more than any single body mention.
    if (new RegExp(escapeRegExp(needle), 'i').test(entry.title)) score += 50;

    let currentHeading: { text: string; slug: string } | null = null;

    const consider = (text: string) => {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        score += 1;
        if (matches.length < 5) {
          const start = Math.max(0, match.index - 60);
          const end = Math.min(text.length, match.index + needle.length + 90);
          matches.push({
            heading: currentHeading?.text ?? null,
            anchor: currentHeading?.slug ?? null,
            excerpt:
              (start > 0 ? '…' : '') +
              text.slice(start, end).replace(/\s+/g, ' ').trim() +
              (end < text.length ? '…' : ''),
          });
        }
        // One excerpt per passage is enough; keep scanning for the score.
        if (matches.length >= 5 && score > 40) break;
      }
    };

    const walk = (block: DocBlock) => {
      switch (block.type) {
        case 'heading':
          currentHeading = { text: block.text, slug: block.slug };
          consider(block.text);
          break;
        case 'paragraph':
          consider(block.content.map((n) => n.value).join(''));
          break;
        case 'list':
          for (const item of block.items) {
            consider(item.content.map((n) => n.value).join(''));
            for (const child of item.children) consider(child.content.map((n) => n.value).join(''));
          }
          break;
        case 'table':
          for (const row of block.rows) {
            consider(row.map((cell) => cell.map((n) => n.value).join(' ')).join(' · '));
          }
          break;
        case 'code':
          consider(block.value);
          break;
        case 'quote':
          block.blocks.forEach(walk);
          break;
        default:
          break;
      }
    };

    parsed.blocks.forEach(walk);

    if (score > 0) {
      hits.push({
        slug: entry.slug,
        title: entry.title,
        category: entry.category,
        matches,
        score,
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, 20);
}
