import { Link } from 'react-router-dom';
import type { DocBlock, DocInlineNode, DocListItem } from '@hrms/shared';
import { cn } from '@/lib/utils';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';

/**
 * Renders a document's block tree.
 *
 * One component per block type, and no `dangerouslySetInnerHTML` anywhere: the
 * API hands over structured data, so there is no markup to trust. A document
 * cannot inject anything into the application because nothing it contains is
 * ever interpreted as markup.
 */

function Inline({ nodes }: { nodes: readonly DocInlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.type) {
          case 'strong':
            return (
              <strong key={index} className="font-semibold text-foreground">
                {node.value}
              </strong>
            );
          case 'em':
            return (
              <em key={index} className="italic">
                {node.value}
              </em>
            );
          case 'strike':
            return (
              <s key={index} className="text-muted-foreground">
                {node.value}
              </s>
            );
          case 'code':
            return (
              <code
                key={index}
                className="rounded bg-surface-muted px-1 py-0.5 font-mono text-[0.9em] text-foreground"
              >
                {node.value}
              </code>
            );
          case 'link':
            // An external link opens away from the application and is marked as
            // such; an internal one is a router link so the help centre never
            // does a full page load.
            return node.external ? (
              <a
                key={index}
                href={node.href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary underline underline-offset-2 hover:no-underline"
              >
                {node.value}
              </a>
            ) : (
              <Link
                key={index}
                to={node.href}
                className="text-primary underline underline-offset-2 hover:no-underline"
              >
                {node.value}
              </Link>
            );
          default:
            return <span key={index}>{node.value}</span>;
        }
      })}
    </>
  );
}

function ListItems({ items }: { items: readonly DocListItem[] }) {
  return (
    <>
      {items.map((item, index) => (
        <li key={index} className="leading-relaxed">
          <Inline nodes={item.content} />
          {item.children.length > 0 ? (
            <ul className="mt-1.5 ml-5 list-disc space-y-1.5 marker:text-muted-foreground">
              <ListItems items={item.children} />
            </ul>
          ) : null}
        </li>
      ))}
    </>
  );
}

const HEADING_CLASS: Record<number, string> = {
  1: 'text-2xl font-semibold tracking-tight mt-8 mb-3 first:mt-0',
  2: 'text-xl font-semibold tracking-tight mt-8 mb-3 first:mt-0',
  3: 'text-[17px] font-semibold tracking-tight mt-6 mb-2',
  4: 'text-[15px] font-semibold mt-5 mb-2',
  5: 'text-[14px] font-semibold mt-4 mb-1.5',
  6: 'text-[13px] font-semibold uppercase tracking-wide text-muted-foreground mt-4 mb-1.5',
};

export function DocBlocks({ blocks }: { blocks: readonly DocBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'heading': {
            const Tag = `h${Math.min(block.level + 1, 6)}` as 'h2';
            return (
              <Tag
                key={index}
                id={block.slug}
                className={cn(HEADING_CLASS[block.level] ?? HEADING_CLASS[3], 'scroll-mt-24')}
              >
                <Inline nodes={block.content} />
              </Tag>
            );
          }

          case 'paragraph':
            return (
              <p key={index} className="my-3 text-[14px] leading-relaxed text-foreground/90">
                <Inline nodes={block.content} />
              </p>
            );

          case 'list':
            return block.ordered ? (
              <ol
                key={index}
                start={block.start}
                className="my-3 ml-5 list-decimal space-y-1.5 text-[14px] text-foreground/90 marker:text-muted-foreground"
              >
                <ListItems items={block.items} />
              </ol>
            ) : (
              <ul
                key={index}
                className="my-3 ml-5 list-disc space-y-1.5 text-[14px] text-foreground/90 marker:text-muted-foreground"
              >
                <ListItems items={block.items} />
              </ul>
            );

          case 'table':
            // Wrapped so a wide table scrolls inside itself rather than pushing
            // the page sideways — the same rule every other table here follows.
            return (
              <div key={index} className="my-4 overflow-hidden rounded-md border border-border">
                <TableWrapper>
                  <Table>
                    <THead>
                      <TR className="hover:bg-transparent">
                        {block.head.map((cell, cellIndex) => (
                          <TH
                            key={cellIndex}
                            className={cn(
                              'whitespace-nowrap',
                              block.align[cellIndex] === 'right' && 'text-right',
                              block.align[cellIndex] === 'center' && 'text-center',
                            )}
                          >
                            <Inline nodes={cell} />
                          </TH>
                        ))}
                      </TR>
                    </THead>
                    <TBody>
                      {block.rows.map((row, rowIndex) => (
                        <TR key={rowIndex}>
                          {row.map((cell, cellIndex) => (
                            <TD
                              key={cellIndex}
                              className={cn(
                                'align-top text-[13px] leading-relaxed',
                                block.align[cellIndex] === 'right' && 'text-right',
                                block.align[cellIndex] === 'center' && 'text-center',
                              )}
                            >
                              <Inline nodes={cell} />
                            </TD>
                          ))}
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableWrapper>
              </div>
            );

          case 'code':
            return (
              <pre
                key={index}
                className="my-4 overflow-x-auto rounded-md border border-border bg-surface-muted p-3 text-[12.5px] leading-relaxed"
              >
                <code className="font-mono text-foreground">{block.value}</code>
              </pre>
            );

          case 'quote':
            return (
              <blockquote
                key={index}
                className="my-4 rounded-r-md border-l-2 border-primary bg-primary-soft/30 py-1 pl-4 pr-3"
              >
                <DocBlocks blocks={block.blocks} />
              </blockquote>
            );

          case 'rule':
            return <hr key={index} className="my-6 border-border" />;

          default:
            return null;
        }
      })}
    </>
  );
}
