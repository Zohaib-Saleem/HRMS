import * as React from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { cn } from '@/lib/utils';

/**
 * What goes out with an asset, and what comes back.
 *
 * Tick boxes over a suggestion list, plus a box for anything else, because
 * accessories are whatever was actually in the bag. `ASSET_ACCESSORY_SUGGESTIONS`
 * is a starting point and not a closed set - the column is a string array, so a
 * company that issues docking stations does not need a release to say so.
 *
 * Used three ways and the third is why `allowCustom` exists: on a RETURN, the
 * options are exactly what was ISSUED and nothing may be added, because the
 * question there is "did this specific thing come back" and a free-text box
 * would let somebody answer a different question.
 */
export function AccessoryPicker({
  id,
  options,
  value,
  onChange,
  allowCustom = true,
}: {
  id: string;
  options: readonly string[];
  value: string[];
  onChange: (next: string[]) => void;
  allowCustom?: boolean;
}) {
  const [draft, setDraft] = React.useState('');

  const toggle = (item: string) => {
    onChange(
      value.some((picked) => picked.toLowerCase() === item.toLowerCase())
        ? value.filter((picked) => picked.toLowerCase() !== item.toLowerCase())
        : [...value, item],
    );
  };

  const addCustom = () => {
    const item = draft.trim();
    if (item === '') return;
    if (!value.some((picked) => picked.toLowerCase() === item.toLowerCase())) {
      onChange([...value, item]);
    }
    setDraft('');
  };

  // Anything picked that is not on the suggestion list still has to be visible
  // and removable, or a typo becomes permanent.
  const extras = value.filter(
    (picked) => !options.some((option) => option.toLowerCase() === picked.toLowerCase()),
  );

  return (
    <div className="space-y-2" id={id}>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const picked = value.some((item) => item.toLowerCase() === option.toLowerCase());
          return (
            <button
              key={option}
              type="button"
              onClick={() => toggle(option)}
              aria-pressed={picked}
              className={cn(
                'rounded-md border px-2.5 py-1 text-[12.5px] transition-colors',
                picked
                  ? 'border-primary bg-primary-soft text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {option}
            </button>
          );
        })}
      </div>

      {extras.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {extras.map((item) => (
            <span
              key={item}
              className="inline-flex items-center gap-1 rounded-md border border-primary bg-primary-soft px-2.5 py-1 text-[12.5px] text-primary"
            >
              {item}
              <button
                type="button"
                aria-label={`Remove ${item}`}
                onClick={() => toggle(item)}
                className="opacity-70 hover:opacity-100"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {allowCustom ? (
        <div className="flex gap-2">
          <Input
            value={draft}
            placeholder="Something else"
            aria-label="Add another accessory"
            maxLength={120}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              addCustom();
            }}
          />
          <Button type="button" variant="outline" size="sm" onClick={addCustom}>
            <Plus />
            Add
          </Button>
        </div>
      ) : null}
    </div>
  );
}
