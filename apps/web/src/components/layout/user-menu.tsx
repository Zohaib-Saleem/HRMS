import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, LogOut, Monitor, Moon, Sun, User as UserIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { cn, initials } from '@/lib/utils';
import { useSession } from '@/features/auth/session-context';
import { useTheme } from '@/app/theme';
import { useConfirm } from '@/components/feedback/confirm-dialog';

const itemClass =
  'flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] outline-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground';

export function UserMenu() {
  const { session, clear } = useSession();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [signingOut, setSigningOut] = React.useState(false);

  if (!session) return null;
  const { user } = session;

  const handleSignOut = async () => {
    const ok = await confirm({
      title: 'Sign out?',
      description: 'You will need to enter your credentials again to get back in.',
      confirmLabel: 'Sign out',
    });
    if (!ok) return;

    setSigningOut(true);
    try {
      await api.post('/auth/logout');
      clear();
      navigate('/login', { replace: true });
      toast.success('Signed out.');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSigningOut(false);
    }
  };

  const themes = [
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
    { value: 'system', label: 'System', icon: Monitor },
  ] as const;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className="flex items-center gap-2.5 rounded-lg py-1 pl-1 pr-2 transition-colors hover:bg-accent data-[state=open]:bg-accent"
        aria-label="Account menu"
      >
        <span
          className="grid size-8 shrink-0 place-items-center rounded-full text-[12px] font-semibold text-white"
          style={{ backgroundColor: user.avatarColor }}
          aria-hidden
        >
          {initials(user.firstName, user.lastName)}
        </span>
        <span className="hidden min-w-0 text-left sm:block">
          <span className="block max-w-36 truncate text-[13px] font-medium leading-tight">
            {user.fullName}
          </span>
          <span className="block max-w-36 truncate text-[11px] leading-tight text-muted-foreground">
            {user.roles[0]?.name ?? 'No role'}
          </span>
        </span>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="z-50 w-64 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg animate-in-fade"
        >
          <div className="border-b border-border px-2.5 pb-2.5 pt-1.5">
            <p className="truncate text-[13px] font-medium">{user.fullName}</p>
            <p className="truncate text-[12px] text-muted-foreground">{user.email}</p>
            {user.employee?.jobTitle ? (
              <p className="mt-1 truncate text-[11px] text-muted-foreground">
                {user.employee.jobTitle}
                {user.employee.departmentName ? ` - ${user.employee.departmentName}` : ''}
              </p>
            ) : null}
          </div>

          <div className="py-1">
            <DropdownMenu.Item className={itemClass} onSelect={() => navigate('/profile')}>
              <UserIcon className="size-4 text-muted-foreground" aria-hidden />
              My profile
            </DropdownMenu.Item>
          </div>

          <div className="border-t border-border py-1">
            <p className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Appearance
            </p>
            {themes.map(({ value, label, icon: Icon }) => (
              <DropdownMenu.Item
                key={value}
                className={itemClass}
                onSelect={(event) => {
                  event.preventDefault();
                  setTheme(value);
                }}
              >
                <Icon className="size-4 text-muted-foreground" aria-hidden />
                <span className="flex-1">{label}</span>
                {theme === value ? <Check className="size-3.5 text-primary" aria-hidden /> : null}
              </DropdownMenu.Item>
            ))}
          </div>

          <div className="border-t border-border pt-1">
            <DropdownMenu.Item
              className={cn(itemClass, 'text-destructive data-[highlighted]:bg-destructive-soft')}
              disabled={signingOut}
              onSelect={() => void handleSignOut()}
            >
              <LogOut className="size-4" aria-hidden />
              Sign out
            </DropdownMenu.Item>
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
