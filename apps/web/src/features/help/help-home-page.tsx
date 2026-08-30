import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, FileText, Lock, Search } from 'lucide-react';
import type { DocCategory, DocSearchHit } from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';

/**
 * The help centre landing page.
 *
 * Shows only the categories and documents this reader may actually open. A
 * document they cannot read is not listed as locked - it is simply absent,
 * because advertising a document and then refusing it tells somebody there is
 * something worth looking for.
 */

export interface DocCatalogue {
  categories: DocCategory[];
  moduleHelp: Record<string, string>;
}

export function HelpHomePage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const term = params.get('q') ?? '';
  const [input, setInput] = React.useState(term);
  const debounced = useDebounced(input, 300);

  React.useEffect(() => {
    setParams(debounced ? { q: debounced } : {}, { replace: true });
  }, [debounced, setParams]);

  const catalogue = useQuery({
    queryKey: ['docs'],
    queryFn: () => api.get<DocCatalogue>('/docs'),
    staleTime: 5 * 60_000,
  });

  const search = useQuery({
    queryKey: ['docs-search', debounced],
    queryFn: () => api.get<DocSearchHit[]>('/docs/search', { query: { q: debounced } }),
    enabled: debounced.trim().length >= 2,
  });

  const searching = debounced.trim().length >= 2;

  return (
    <>
      <PageHeader
        title="Help and documentation"
        description="How this system works, written from what it actually does."
      />

      <Card className="mb-6 p-4">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search the documentation — try payroll, ZKTeco, overtime, leave…"
            className="pl-9"
            aria-label="Search the documentation"
            autoFocus
          />
        </div>
      </Card>

      {searching ? (
        <SearchResults
          term={debounced}
          isLoading={search.isLoading}
          isError={search.isError}
          error={search.error}
          hits={search.data ?? []}
          onOpen={(slug, anchor) => navigate(`/help/${slug}${anchor ? `#${anchor}` : ''}`)}
        />
      ) : catalogue.isError ? (
        <Card>
          <ErrorState error={catalogue.error} onRetry={() => void catalogue.refetch()} />
        </Card>
      ) : catalogue.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} className="p-5">
              <Skeleton className="mb-3 h-5 w-40" />
              <Skeleton className="mb-2 h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {catalogue.data?.categories.map((category) => (
            <Card key={category.key} className="overflow-hidden">
              <div className="border-b border-border px-5 py-4">
                <h2 className="text-[15px] font-semibold tracking-tight">{category.title}</h2>
                <p className="text-[12.5px] text-muted-foreground">{category.description}</p>
              </div>
              <ul className="divide-y divide-border">
                {category.documents.map((doc) => (
                  <li key={doc.slug}>
                    <Link
                      to={`/help/${doc.slug}`}
                      className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-accent"
                    >
                      <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-[13.5px] font-medium">{doc.title}</span>
                          {doc.restricted ? (
                            <Badge variant="neutral" className="gap-1">
                              <Lock className="size-3" aria-hidden />
                              Restricted
                            </Badge>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block text-[12.5px] leading-relaxed text-muted-foreground">
                          {doc.summary}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function SearchResults({
  term,
  isLoading,
  isError,
  error,
  hits,
  onOpen,
}: {
  term: string;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  hits: DocSearchHit[];
  onOpen: (slug: string, anchor: string | null) => void;
}) {
  if (isError) {
    return (
      <Card>
        <ErrorState error={error} />
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card className="p-5">
        <Skeleton className="mb-3 h-5 w-48" />
        <Skeleton className="h-4 w-full" />
      </Card>
    );
  }

  if (hits.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={BookOpen}
          title={`Nothing matches “${term}”`}
          description="Try a different word, or browse the categories instead."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted-foreground">
        {hits.length} document{hits.length === 1 ? '' : 's'} match “{term}”.
      </p>

      {hits.map((hit) => (
        <Card key={hit.slug} className="overflow-hidden">
          <button
            type="button"
            onClick={() => onOpen(hit.slug, null)}
            className="w-full border-b border-border px-5 py-3 text-left transition-colors hover:bg-accent"
          >
            <span className="text-[14px] font-semibold">{hit.title}</span>
          </button>
          <ul className="divide-y divide-border">
            {hit.matches.map((match, index) => (
              <li key={index}>
                <button
                  type="button"
                  onClick={() => onOpen(hit.slug, match.anchor)}
                  className="w-full px-5 py-2.5 text-left transition-colors hover:bg-accent"
                >
                  {match.heading ? (
                    <span className="block text-[12px] font-medium text-primary">
                      {match.heading}
                    </span>
                  ) : null}
                  <span className="block text-[12.5px] leading-relaxed text-muted-foreground">
                    {match.excerpt}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
