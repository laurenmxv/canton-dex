import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@openzeppelin/ui-components';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FAUCET_SECTION } from '../features/tokens/navigation';
import { Mark } from './Mark';
import { useIsCompact } from './useMediaQuery';

interface SidebarProps<Id extends string> {
  items: readonly { id: Id; label: string }[];
  activeId: Id;
  onSelect: (id: Id) => void;
  /** The developer docs, a group of its own beside the role's sections. */
  docs: { active: boolean; onSelect: () => void };
  /** Identity, role and sign-out. Composed by the shell, rendered at the foot. */
  footer: ReactNode;
}

const DOCS_ICON = 'dev-docs';

function AccountIcon() {
  return (
    <svg
      className="size-[1.0625rem]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
    </svg>
  );
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
    'trader-liquidity': (
      <>
        <path d="M12 3c3.5 4.2 6 7.6 6 10.5a6 6 0 0 1-12 0C6 10.6 8.5 7.2 12 3z" />
        <path d="M9 14.5a3 3 0 0 0 3 3" />
      </>
    ),
    [FAUCET_SECTION]: (
      <>
        <path d="M4 10h11a4 4 0 0 1 4 4v1h-5v-1H4M9 10V6M6 6h6" />
        <path d="M17 18c-2 2-2 3 0 3s2-1 0-3" />
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
    [DOCS_ICON]: (
      <>
        <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z" />
        <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19M9 7h6M9 10.5h4" />
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

const COLUMN =
  'bg-sidebar flex min-h-0 flex-none flex-col overflow-hidden border-r transition-[width] duration-180 ease-out';

/** The column, and the drawer that replaces it below the wide breakpoint. */
const SIDEBAR = `${COLUMN} w-62`;

/** The collapsed column: icons only, each named for assistive technology and on hover. */
const RAIL = `${COLUMN} w-16`;

const ROW_STATE =
  'group text-muted-foreground hover:bg-surface-strong hover:text-foreground aria-[current=page]:bg-card aria-[current=page]:text-foreground aria-[current=page]:shadow-card';

const ROW = `${ROW_STATE} h-auto justify-start gap-2.5 px-3 py-[0.5625rem] text-left text-sm font-medium`;

const RAIL_ROW = `${ROW_STATE} size-10 justify-center self-center p-0`;

const ICON_BUTTON = 'text-muted-foreground hover:text-foreground size-8 flex-none';

/** A layout swap that comes after the width change, so no control is ever clipped. */
const SWAP = 'animate-sidebar-swap';

/** The column's width transition, or 0 where it does not run, as under reduced motion or in tests. */
function widthTransitionMs(element: HTMLElement | null): number {
  if (!element) return 0;
  const seconds = parseFloat(getComputedStyle(element).transitionDuration) || 0;
  return seconds >= 0.05 ? seconds * 1000 : 0;
}

/** Where the column's width is kept. Like the theme, it says nothing about the reader. */
const COLLAPSED_KEY = 'canton-dex.sidebar';

/** Storage is missing in a private window and disabled in some test runtimes. */
function storage(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** A blocked store can refuse the read itself, not only access to the store. */
function storedCollapsed(): boolean {
  try {
    return storage()?.getItem(COLLAPSED_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

/** The wide column's width, remembered. Without storage the choice lasts until the page reloads. */
function useCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(storedCollapsed);
  const toggle = useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      try {
        storage()?.setItem(COLLAPSED_KEY, next ? 'collapsed' : 'expanded');
      } catch {
        // A browser that refuses to store it still honours it for this page.
      }
      return next;
    });
  }, []);
  return [collapsed, toggle];
}

function Chevrons({ toward }: { toward: 'left' | 'right' }) {
  return (
    <svg
      className="size-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={toward === 'left' ? 'M11 17l-5-5 5-5M18 17l-5-5 5-5' : 'M13 17l5-5-5-5M6 17l5-5-5-5'} />
    </svg>
  );
}

/** A label beside a rail icon, on hover and on keyboard focus. */
function RailTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

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
  docs,
  footer,
}: SidebarProps<Id>) {
  const compact = useIsCompact();
  const [open, setOpen] = useState(false);
  const [collapsed, toggleCollapsed] = useCollapsed();
  // The drawer always shows labels; only the wide column collapses.
  const rail = !compact && collapsed;
  // While the column widens, it keeps the icon rail; the labelled layout arrives at full width.
  const [expanding, setExpanding] = useState(false);
  const [swapped, setSwapped] = useState(false);
  const showRail = rail || (!compact && expanding);
  const column = useRef<HTMLElement>(null);
  const adopt = useRef(false);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);

  // Each layout renders its own toggle, so the new one takes the focus the old one held.
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    toggleButton.current?.focus();
  }, [showRail]);

  useEffect(() => {
    if (!expanding) return;
    const aside = column.current;
    const settle = () => setExpanding(false);
    const ended = (event: TransitionEvent) => {
      if (event.target === aside && event.propertyName === 'width') settle();
    };
    aside?.addEventListener('transitionend', ended);
    // A transition that never reports its end, as in a hidden tab, still settles.
    const timer = window.setTimeout(settle, widthTransitionMs(aside) + 80);
    return () => {
      aside?.removeEventListener('transitionend', ended);
      window.clearTimeout(timer);
    };
  }, [expanding]);

  // A drawer left open while the viewport grows takes its trigger with it, so
  // the column that replaces it takes the focus the drawer was holding.
  useEffect(() => {
    if (compact) return;
    if (open) {
      setOpen(false);
      adopt.current = true;
    } else if (adopt.current) {
      adopt.current = false;
      column.current?.querySelector<HTMLElement>('nav button:not([disabled])')?.focus();
    }
  }, [compact, open]);

  const row = (key: string, label: string, current: boolean, select: () => void) => {
    const button = (
      <Button
        key={key}
        type="button"
        variant="ghost"
        className={showRail ? RAIL_ROW : ROW}
        aria-current={current ? 'page' : undefined}
        onClick={() => {
          select();
          if (compact) setOpen(false);
        }}
      >
        <SectionIcon id={key} />
        <span className={showRail ? 'sr-only' : undefined}>{label}</span>
      </Button>
    );
    return showRail ? (
      <RailTip key={key} label={label}>
        {button}
      </RailTip>
    ) : (
      button
    );
  };

  const toggle = compact ? null : (
    <Button
      ref={toggleButton}
      type="button"
      variant="ghost"
      size="icon"
      className={showRail ? ICON_BUTTON : `${ICON_BUTTON} ml-auto`}
      onClick={() => {
        refocus.current = true;
        setSwapped(true);
        setExpanding(rail && widthTransitionMs(column.current) > 0);
        toggleCollapsed();
      }}
      aria-label={rail ? 'Expand sidebar' : 'Collapse sidebar'}
    >
      <Chevrons toward={rail ? 'right' : 'left'} />
    </Button>
  );

  const panelBody = (
    <>
      {showRail ? (
        <div className="flex flex-col items-center gap-3 pt-4.5 pb-3">
          <Mark />
          <RailTip label={rail ? 'Expand sidebar' : 'Collapse sidebar'}>{toggle}</RailTip>
        </div>
      ) : (
        <div className="flex items-center gap-2.5 px-4.5 pt-4.5 pb-4 font-semibold tracking-[-0.015em]">
          <Mark />
          <span>Canton DEX</span>
          {toggle}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
        {/* Signed out, the docs are the only destination, so there is no section list. */}
        {items.length > 0 ? (
          <nav className="flex flex-col gap-[0.1875rem]" aria-label="Sections">
            {items.map((item) =>
              row(item.id, item.label, !docs.active && item.id === activeId, () => onSelect(item.id)),
            )}
          </nav>
        ) : null}
        <nav className="mt-5 flex flex-col gap-[0.1875rem] first:mt-0" aria-label="Developer">
          {showRail ? (
            <span className="bg-border mx-auto mb-1 h-px w-6" aria-hidden="true" />
          ) : (
            <span className="text-muted-foreground px-3 pb-1 text-[0.6875rem] font-semibold tracking-[0.04em] uppercase">
              Dev
            </span>
          )}
          {row(DOCS_ICON, 'Docs', docs.active, docs.onSelect)}
        </nav>
      </div>
      {showRail ? (
        // The footer's own controls, unchanged, behind one account button.
        <div className="flex justify-center border-t py-3">
          <Popover>
            <RailTip label="Account and settings">
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={ICON_BUTTON}
                  aria-label="Account and settings"
                >
                  <AccountIcon />
                </Button>
              </PopoverTrigger>
            </RailTip>
            <PopoverContent
              side="right"
              align="end"
              sideOffset={8}
              aria-label="Account and settings"
              className="flex w-60 flex-col gap-2.5 p-3.5"
            >
              {footer}
            </PopoverContent>
          </Popover>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5 border-t px-3.5 pt-3.5 pb-4">{footer}</div>
      )}
    </>
  );

  if (!compact) {
    return (
      <aside className={rail ? RAIL : SIDEBAR} ref={column}>
        <TooltipProvider delayDuration={150}>
          {/* The rail keeps its own width, pinned to the left, while the column changes around it. */}
          <div
            key={showRail ? 'rail' : 'full'}
            className={`flex min-h-0 w-full flex-1 flex-col ${showRail ? 'max-w-16' : ''} ${swapped ? SWAP : ''}`}
          >
            {panelBody}
          </div>
        </TooltipProvider>
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
