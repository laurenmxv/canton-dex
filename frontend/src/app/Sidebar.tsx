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
