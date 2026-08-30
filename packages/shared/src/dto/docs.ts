import { z } from 'zod';

/**
 * The in-application help centre.
 *
 * The API returns documents as a typed block tree rather than HTML or raw
 * markdown, so the client renders them with ordinary React components and there
 * is no markup to sanitise anywhere.
 */

export type DocInlineNode =
  | { type: 'text'; value: string }
  | { type: 'strong'; value: string }
  | { type: 'em'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strike'; value: string }
  | { type: 'link'; value: string; href: string; external: boolean };

export interface DocListItem {
  content: DocInlineNode[];
  children: DocListItem[];
}

export type DocBlock =
  | { type: 'heading'; level: number; text: string; slug: string; content: DocInlineNode[] }
  | { type: 'paragraph'; content: DocInlineNode[] }
  | { type: 'list'; ordered: boolean; start: number; items: DocListItem[] }
  | {
      type: 'table';
      head: DocInlineNode[][];
      rows: DocInlineNode[][][];
      align: Array<'left' | 'right' | 'center'>;
    }
  | { type: 'code'; language: string | null; value: string }
  | { type: 'quote'; blocks: DocBlock[] }
  | { type: 'rule' };

export interface DocSummary {
  slug: string;
  title: string;
  summary: string;
  category: string;
  /** True when this document is only visible to some roles. */
  restricted: boolean;
}

export interface DocCategory {
  key: string;
  title: string;
  description: string;
  documents: DocSummary[];
}

export interface DocHeading {
  level: number;
  text: string;
  slug: string;
}

export interface DocDetail {
  slug: string;
  title: string;
  summary: string;
  category: string;
  categoryTitle: string;
  blocks: DocBlock[];
  /** For the on-page contents panel. */
  headings: DocHeading[];
  previous: { slug: string; title: string } | null;
  next: { slug: string; title: string } | null;
}

export interface DocSearchHit {
  slug: string;
  title: string;
  category: string;
  matches: Array<{ heading: string | null; anchor: string | null; excerpt: string }>;
  score: number;
}

export const docSearchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Type at least two characters.').max(80),
});
