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
      className="sidebar-icon"
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

const FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'select:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Primary navigation. A column beside the content on a wide viewport, and a
 * drawer below it, where it behaves as a dialog: the scrim closes it, Escape
 * closes it, Tab stays inside it, and focus returns to the button that opened
 * it.
 */
export function Sidebar<Id extends string>({
  items,
  activeId,
  onSelect,
  footer,
}: SidebarProps<Id>) {
  const compact = useIsCompact();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const adopt = useRef(false);

  // A drawer left open while the viewport grows would trap focus in a column,
  // and its toggle no longer exists to take focus back, so the column takes it.
  useEffect(() => {
    if (compact) return;
    if (open) {
      setOpen(false);
      adopt.current = true;
    } else if (adopt.current) {
      adopt.current = false;
      focusFirst(panel.current);
    }
  }, [compact, open]);

  useEffect(() => {
    if (open) focusFirst(panel.current);
  }, [open]);

  function close() {
    setOpen(false);
    toggle.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab' || !panel.current) return;
    const stops = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const panelBody = (
    <>
      <div className="brand sidebar-brand">
        <Mark />
        <span>Canton DEX</span>
        {compact ? (
          <button type="button" className="menu-button menu-close" onClick={close}>
            Close menu
          </button>
        ) : null}
      </div>
      <nav className="sidebar-nav" aria-label="Sections">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="sidebar-link"
            aria-current={item.id === activeId ? 'page' : undefined}
            onClick={() => {
              onSelect(item.id);
              if (compact) close();
            }}
          >
            <SectionIcon id={item.id} />
            {item.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">{footer}</div>
    </>
  );

  if (!compact) {
    return (
      <aside className="sidebar" ref={panel}>
        {panelBody}
      </aside>
    );
  }

  return (
    <>
      <div className="mobile-bar">
        <button
          ref={toggle}
          type="button"
          className="menu-button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true">☰</span>
          Menu
        </button>
        <div className="brand">
          <Mark />
          <span>Canton DEX</span>
        </div>
      </div>

      {open ? (
        <>
          <div className="scrim" onClick={close} aria-hidden="true" />
          <aside
            ref={panel}
            className="sidebar sidebar-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Sections"
            onKeyDown={onKeyDown}
          >
            {panelBody}
          </aside>
        </>
      ) : null}
    </>
  );
}

function focusFirst(within: HTMLElement | null) {
  within?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
}
