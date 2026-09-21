import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@openzeppelin/ui-components';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Mark } from './Mark';
import { useIsCompact } from './useMediaQuery';

interface SidebarProps<Id extends string> {
  items: readonly { id: Id; label: string }[];
  activeId: Id;
  onSelect: (id: Id) => void;
  /** Identity, role and sign-out. Composed by the shell, rendered at the foot. */
  footer: ReactNode;
}

/**
 * A glyph per section, so a reader finds a row by its shape before reading it.
 * It repeats the label beside it and is hidden from assistive technology.
 */
function SectionIcon({ id }: { id: string }) {
  const paths: Record<string, ReactNode> = {
    'trader-dashboard': (
      <>
        <rect x="3" y="3" width="7" height="8" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="11" width="7" height="10" rx="1.5" />
      </>
    ),
    'trader-swap': (
      <>
        <path d="M7 4v13M7 17l-3-3M7 17l3-3" />
        <path d="M17 20V7M17 7l-3 3M17 7l3 3" />
      </>
    ),
    'trader-onboarding': (
      <>
        <path d="M20 6 9 17l-5-5" />
      </>
    ),
    'operator-onboardings': (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </>
    ),
    'operator-pools': (
      <>
        <circle cx="9" cy="12" r="6" />
        <circle cx="15" cy="12" r="6" />
      </>
    ),
    'operator-settlement': (
      <>
        <path d="M3 17l6-6 4 4 7-8" />
        <path d="M14 7h6v6" />
      </>
    ),
  };
  return (
    <svg
      className="size-[1.0625rem] flex-none opacity-85 group-aria-[current=page]:text-primary group-aria-[current=page]:opacity-100"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[id] ?? <circle cx="12" cy="12" r="7" />}
    </svg>
  );
}

/** The column, and the drawer that replaces it below the wide breakpoint. */
const SIDEBAR = 'bg-sidebar flex w-62 min-h-0 flex-none flex-col border-r';

/**
 * Primary navigation. A column beside the content on a wide viewport, and a
 * drawer below it.
 *
 * The drawer is the kit's dialog, which owns the scrim, the focus trap, the
 * Escape key and the return of focus to the trigger. It is positioned against
 * the left edge instead of the middle of the screen, and it keeps the kit's
 * own close control.
 *
 * The rows are the kit's ghost buttons rather than its `SidebarButton`, which
 * takes a fixed prop list and no rest, so it cannot carry `aria-current`. That
 * attribute is how a reader who cannot see the highlight knows which section
 * they are in.
 */
export function Sidebar<Id extends string>({
  items,
  activeId,
  onSelect,
  footer,
}: SidebarProps<Id>) {
  const compact = useIsCompact();
  const [open, setOpen] = useState(false);
  const column = useRef<HTMLElement>(null);
  const adopt = useRef(false);

  // A drawer left open while the viewport grows takes its trigger with it, so
  // the column that replaces it takes the focus the drawer was holding.
  useEffect(() => {
    if (compact) return;
    if (open) {
      setOpen(false);
      adopt.current = true;
    } else if (adopt.current) {
      adopt.current = false;
      column.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    }
  }, [compact, open]);

  const panelBody = (
    <>
      <div className="flex items-center gap-2.5 px-4.5 pt-4.5 pb-4 font-semibold tracking-[-0.015em]">
        <Mark />
        <span>Canton DEX</span>
      </div>
      <nav
        className="flex flex-1 flex-col gap-[0.1875rem] overflow-y-auto px-3 py-2"
        aria-label="Sections"
      >
        {items.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant="ghost"
            className="group text-muted-foreground hover:bg-surface-strong hover:text-foreground aria-[current=page]:bg-card aria-[current=page]:text-foreground aria-[current=page]:shadow-card h-auto justify-start gap-2.5 px-3 py-[0.5625rem] text-left text-sm font-medium"
            aria-current={item.id === activeId ? 'page' : undefined}
            onClick={() => {
              onSelect(item.id);
              if (compact) setOpen(false);
            }}
          >
            <SectionIcon id={item.id} />
            {item.label}
          </Button>
        ))}
      </nav>
      <div className="flex flex-col gap-2.5 border-t px-3.5 pt-3.5 pb-4">{footer}</div>
    </>
  );

  if (!compact) {
    return (
      <aside className={SIDEBAR} ref={column}>
        {panelBody}
      </aside>
    );
  }

  return (
    <div className="bg-background sticky top-0 z-[1100] flex items-center gap-3 border-b px-4 py-2.5">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            <span aria-hidden="true">☰</span>
            Menu
          </Button>
        </DialogTrigger>
        <DialogContent
          aria-describedby={undefined}
          className={`${SIDEBAR} animate-drawer-in top-0 left-0 h-full max-h-none w-[min(17rem,82vw)] max-w-none translate-x-0 translate-y-0 gap-0 rounded-none p-0 sm:rounded-none`}
        >
          <DialogTitle className="sr-only">Sections</DialogTitle>
          {panelBody}
        </DialogContent>
      </Dialog>
      <div className="flex items-center gap-2.5 font-semibold tracking-[-0.015em]">
        <Mark />
        <span>Canton DEX</span>
      </div>
    </div>
  );
}
