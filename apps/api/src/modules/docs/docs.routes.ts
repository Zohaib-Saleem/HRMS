import type { FastifyPluginAsync } from 'fastify';
import {
  docSearchQuerySchema,
  type DocCategory,
  type DocDetail,
  type DocSearchHit,
  type DocSummary,
} from '@hrms/shared';
import { parseOrThrow } from '../../core/validate.js';
import { requireAuth, requireAuthContext } from '../../auth/guards.js';
import { DOC_CATEGORIES, MODULE_HELP } from './catalogue.js';
import { loadDocument, searchDocs, visibleEntries } from './docs.service.js';

/**
 * The help centre.
 *
 * Readable by any signed-in user; **what** they can read is narrowed per
 * document by the same permissions that gate the corresponding screens. An
 * employee who cannot open the payroll module cannot read the payroll guide
 * either, and the catalogue they receive does not mention it - a listing that
 * advertised documents it then refused would be an invitation to go looking.
 *
 * Nothing here reads a path from a request. See `docs.service.ts`.
 */

export const docsRoutes: FastifyPluginAsync = async (app) => {
  /** Signed in is enough to reach the help centre at all. */
  app.addHook('preHandler', requireAuth);

  /** The catalogue, grouped, narrowed to what this caller may open. */
  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const entries = visibleEntries(auth.permissions);

    const summaries = await Promise.all(
      entries.map(async (entry): Promise<DocSummary & { order: number }> => ({
        slug: entry.slug,
        title: entry.title,
        // The catalogue's own one-liner, not the document's first paragraph:
        // written for a card, where the opening sentence of a manual is not.
        summary: entry.summary,
        category: entry.category,
        restricted: entry.permission !== undefined,
        order: entry.order,
      })),
    );

    const categories: DocCategory[] = DOC_CATEGORIES.map((category) => ({
      key: category.key,
      title: category.title,
      description: category.description,
      documents: summaries
        .filter((doc) => doc.category === category.key)
        .sort((a, b) => a.order - b.order)
        .map(({ order: _order, ...doc }) => doc),
      // Only categories that actually have something in them for this reader.
    })).filter((category) => category.documents.length > 0);

    return reply.send({ data: { categories, moduleHelp: MODULE_HELP } });
  });

  /**
   * Search.
   *
   * Placed before `/:slug` so the literal path wins over the parameter - a
   * route ordering mistake here would make "search" a document slug.
   */
  app.get('/search', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(docSearchQuerySchema, request.query);

    const hits: DocSearchHit[] = await searchDocs(query.q, auth.permissions);
    return reply.send({ data: hits });
  });

  /** One document, with its neighbours for previous/next navigation. */
  app.get('/:slug', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { slug } = request.params as { slug: string };

    // `slug` is a lookup key, never a path. An unknown or forbidden one is the
    // same 404, so the catalogue cannot be enumerated by probing.
    const loaded = await loadDocument(slug, auth.permissions);

    // Neighbours are drawn from what this reader can actually open, so
    // "next" never points at a document that would then refuse them.
    const ordered = visibleEntries(auth.permissions).sort((a, b) => {
      const categoryA = DOC_CATEGORIES.findIndex((c) => c.key === a.category);
      const categoryB = DOC_CATEGORIES.findIndex((c) => c.key === b.category);
      return categoryA === categoryB ? a.order - b.order : categoryA - categoryB;
    });

    const position = ordered.findIndex((entry) => entry.slug === slug);
    const previous = position > 0 ? ordered[position - 1] : undefined;
    const next = position >= 0 && position < ordered.length - 1 ? ordered[position + 1] : undefined;

    const category = DOC_CATEGORIES.find((c) => c.key === loaded.entry.category);

    const data: DocDetail = {
      slug: loaded.entry.slug,
      title: loaded.entry.title,
      summary: loaded.summary || loaded.entry.summary,
      category: loaded.entry.category,
      categoryTitle: category?.title ?? '',
      blocks: loaded.blocks,
      headings: loaded.headings,
      previous: previous ? { slug: previous.slug, title: previous.title } : null,
      next: next ? { slug: next.slug, title: next.title } : null,
    };

    return reply.send({ data });
  });
};
