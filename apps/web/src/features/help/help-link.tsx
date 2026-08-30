import { Link } from 'react-router-dom';
import { HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * A module's link into its own documentation.
 *
 * Deliberately tiny and deliberately a plain link: adding contextual help
 * should not mean redesigning the page it sits on. Dropped into an existing
 * `PageHeader` actions slot, it inherits that page's layout entirely.
 *
 * A reader without permission for the target document lands on a clear
 * "not available" page rather than an error - the server refuses it the same
 * way it refuses the module itself.
 */
export function HelpLink({ slug, label = 'Help' }: { slug: string; label?: string }) {
  return (
    <Button variant="ghost" size="sm" asChild title="Open the documentation for this screen">
      <Link to={`/help/${slug}`}>
        <HelpCircle />
        {label}
      </Link>
    </Button>
  );
}
