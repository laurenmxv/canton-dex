import type { ReactNode } from 'react';
import { Card } from '../../ui/Card';
import { ARCHITECTURE_HOME, FLOWS_HOME } from './routes';

function AtlasIcon() {
  return (
    <svg
      className="size-7"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="5" rx="1.2" />
      <rect x="14" y="3" width="7" height="5" rx="1.2" />
      <rect x="8.5" y="16" width="7" height="5" rx="1.2" />
      <path d="M6.5 8v3.5h11V8M12 11.5V16" />
    </svg>
  );
}

function FlowIcon() {
  return (
    <svg
      className="size-7"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 3v18M12 3v18M20 3v18" />
      <rect x="6" y="5" width="4" height="3" rx="0.8" />
      <rect x="14" y="10" width="4" height="3" rx="0.8" />
      <rect x="6" y="16" width="4" height="3" rx="0.8" />
      <path d="M10 6.5h2.5v3.5H14M14 11.5h-2.5v6H10" />
    </svg>
  );
}

/** Every docs page, with the route that opens it. */
const pages: readonly { href: string; title: string; summary: string; icon: ReactNode }[] = [
  {
    href: ARCHITECTURE_HOME,
    title: 'Architecture Atlas',
    summary: 'Layers and source-documented modules.',
    icon: <AtlasIcon />,
  },
  {
    href: FLOWS_HOME,
    title: 'Daml flows',
    summary: 'Contract steps per workflow, from their PlantUML sources.',
    icon: <FlowIcon />,
  },
];

/** The docs home. It loads no page content, so it opens at once. */
export function DocsIndex() {
  return (
    <div className="bg-surface flex flex-1 flex-col">
      <header className="bg-card flex min-h-12 flex-none items-center border-b px-4 py-1.5">
        <h1 className="text-sm font-semibold tracking-[-0.01em]">Docs</h1>
      </header>
      <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] gap-5 p-4 sm:p-6">
        {pages.map((page) => (
          <li key={page.href}>
            <a
              href={page.href}
              className="group focus-visible:ring-ring block h-full rounded-lg outline-none hover:no-underline focus-visible:ring-2"
            >
              <Card className="group-hover:border-primary-border flex h-full min-h-60 flex-col items-start gap-8 p-6 transition-colors sm:min-h-64 sm:p-8">
                <span className="border-primary-border bg-primary-soft text-primary grid size-14 flex-none place-items-center rounded-md border">
                  {page.icon}
                </span>
                <span className="flex w-full items-start gap-6">
                  <span className="flex min-w-0 flex-1 flex-col gap-2">
                    <span className="text-xl font-semibold tracking-[-0.01em]">{page.title}</span>
                    <span className="text-muted-foreground max-w-sm text-sm leading-relaxed">
                      {page.summary}
                    </span>
                  </span>
                  <span
                    className="text-muted-foreground group-hover:text-primary flex-none text-2xl"
                    aria-hidden="true"
                  >
                    →
                  </span>
                </span>
              </Card>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
