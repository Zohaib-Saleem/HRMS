// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BreadcrumbTitleProvider, useBreadcrumbTitle } from './breadcrumb-title';

/**
 * A record page naming itself in the breadcrumb.
 *
 * The trail is derived from the URL, which leaves the last segment of a record
 * page as a raw id - unreadable, and rendered as a word by `capitalize`. These
 * assertions are about the handover: the page publishes the name it fetched,
 * and it stops publishing when the reader leaves, so the next page cannot show
 * the previous record's name while its own request is still in flight.
 */

afterEach(cleanup);

function Harness({ title, mounted = true }: { title?: string | null; mounted?: boolean }) {
  const [current, setCurrent] = React.useState<string | null>(null);
  return (
    <>
      <span data-testid="crumb">{current ?? '(none)'}</span>
      <BreadcrumbTitleProvider setTitle={setCurrent}>
        {mounted ? <Page title={title} /> : null}
      </BreadcrumbTitleProvider>
    </>
  );
}

function Page({ title }: { title?: string | null }) {
  useBreadcrumbTitle(title);
  return null;
}

const crumb = () => screen.getByTestId('crumb').textContent;

describe('a page naming itself in the breadcrumb', () => {
  it('publishes the name it was given', () => {
    render(<Harness title="Abdul Rehman" />);
    expect(crumb()).toBe('Abdul Rehman');
  });

  it('publishes nothing while the record is still loading', () => {
    // The page renders before its fetch resolves, and an empty name must not
    // replace the existing fallback with a blank crumb.
    render(<Harness title="" />);
    expect(crumb()).toBe('(none)');
  });

  it('treats a whitespace-only name as no name at all', () => {
    render(<Harness title="   " />);
    expect(crumb()).toBe('(none)');
  });

  it('publishes nothing when handed null or undefined', () => {
    const { rerender } = render(<Harness title={null} />);
    expect(crumb()).toBe('(none)');
    rerender(<Harness title={undefined} />);
    expect(crumb()).toBe('(none)');
  });

  it('follows the name when the record arrives', () => {
    const { rerender } = render(<Harness title="" />);
    expect(crumb()).toBe('(none)');
    rerender(<Harness title="Amara Osei" />);
    expect(crumb()).toBe('Amara Osei');
  });

  it('clears the name when the page goes away', () => {
    const { rerender } = render(<Harness title="Amara Osei" />);
    expect(crumb()).toBe('Amara Osei');
    rerender(<Harness title="Amara Osei" mounted={false} />);
    expect(crumb()).toBe('(none)');
  });

  it('does nothing outside a provider, rather than throwing', () => {
    // The default setter is a no-op, so a page used in isolation - a test, a
    // storybook - is not obliged to bring the shell with it.
    expect(() => render(<Page title="Somebody" />)).not.toThrow();
  });
});
