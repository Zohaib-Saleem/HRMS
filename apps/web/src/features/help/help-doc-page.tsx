import * as React from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, BookOpen } from 'lucide-react';
import type { DocDetail } from '@hrms/shared';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { DocBlocks } from './doc-blocks';

/**
 * One document.
 *
 * Two columns on a wide screen — the document, and its contents. On anything
 * narrower the contents collapse into a details element above the text rather
 * than becoming a second scrolling region, which is what would otherwise
 * produce the nested-scroll problem this application avoids elsewhere.
 *
 * Nothing here scrolls independently: the page scrolls, once, like every other
 * screen.
 */

export function HelpDocPage() {
  const { slug = '' } = useParams();
  const { hash } = useLocation();

  const query = useQuery({
    queryKey: ['doc', slug],
    queryFn: () => api.get<DocDetail>(`/docs/${slug}`),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });

  const doc = query.data;

  /**
   * Jumps to the anchor once the document is on the page.
   *
   * The browser cannot do this itself: the content arrives after navigation, so
   * by the time the element exists the browser has long since given up looking
   * for it.
   */
  React.useEffect(() => {
    if (!doc || !hash) return;
    const id = decodeURIComponent(hash.slice(1));
    const target = document.getElementById(id);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [doc, hash]);

  const notFound = query.error instanceof ApiError && query.error.status === 404;

  if (notFound) {
    return (
      <Card>
        <EmptyState
          icon={BookOpen}
          title="That document is not available"
          description="It may not exist, or it may be restricted to another role."
          action={
            <Button variant="outline" size="sm" asChild>
              <Link to="/help">Back to documentation</Link>
            </Button>
          }
        />
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  return (
    <>
      <div className="mb-4">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/help">
            <ArrowLeft />
            All documentation
          </Link>
        </Button>
      </div>

      {query.isLoading || !doc ? (
        <Card className="p-6">
          <Skeleton className="mb-4 h-7 w-64" />
          <Skeleton className="mb-2 h-4 w-full" />
          <Skeleton className="mb-2 h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_240px] lg:items-start">
          <Card className="min-w-0 p-5 sm:p-7">
            <header className="mb-5 border-b border-border pb-4">
              {doc.categoryTitle ? (
                <p className="text-[12px] font-medium uppercase tracking-wide text-primary">
                  {doc.categoryTitle}
                </p>
              ) : null}
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">{doc.title}</h1>
            </header>

            {/* The document itself. */}
            <article className="min-w-0">
              <DocBlocks blocks={doc.blocks} />
            </article>

            {doc.previous || doc.next ? (
              <nav className="mt-8 flex flex-wrap gap-3 border-t border-border pt-5">
                {doc.previous ? (
                  <Button variant="outline" size="sm" asChild className="min-w-0">
                    <Link to={`/help/${doc.previous.slug}`}>
                      <ArrowLeft />
                      <span className="truncate">{doc.previous.title}</span>
                    </Link>
                  </Button>
                ) : null}
                {doc.next ? (
                  <Button variant="outline" size="sm" asChild className="ml-auto min-w-0">
                    <Link to={`/help/${doc.next.slug}`}>
                      <span className="truncate">{doc.next.title}</span>
                      <ArrowRight />
                    </Link>
                  </Button>
                ) : null}
              </nav>
            ) : null}
          </Card>

          {doc.headings.length > 1 ? <Contents headings={doc.headings} /> : null}
        </div>
      )}
    </>
  );
}

/**
 * On-page contents.
 *
 * Sticky on a wide screen, an ordinary collapsed block on a narrow one. It is
 * deliberately not a scrolling panel: a second scroll region beside the text is
 * the exact problem this application fixed elsewhere.
 */
function Contents({ headings }: { headings: DocDetail['headings'] }) {
  const items = (
    <ul className="space-y-1">
      {headings.map((heading) => (
        <li key={heading.slug}>
          <a
            href={`#${heading.slug}`}
            className={cn(
              'block truncate rounded px-2 py-1 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              heading.level === 3 && 'pl-4',
            )}
          >
            {heading.text}
          </a>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      {/* Narrow: collapsed, above the document, in the normal flow. */}
      <details className="lg:hidden">
        <summary className="cursor-pointer rounded-md border border-border px-3 py-2 text-[13px] font-medium">
          On this page
        </summary>
        <div className="mt-2 rounded-md border border-border p-2">{items}</div>
      </details>

      {/* Wide: sticky beside the document. */}
      <nav className="hidden lg:sticky lg:top-6 lg:block" aria-label="On this page">
        <p className="mb-2 px-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          On this page
        </p>
        {items}
      </nav>
    </>
  );
}
