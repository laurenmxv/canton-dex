import { DOCS_HOME } from '../routes';
import { Atlas } from './Atlas';
import './atlas.css';

/**
 * The Architecture Atlas docs page. Its breadcrumb shares the Atlas toolbar
 * row, so the diagram keeps the height.
 */
export function AtlasPage() {
  return (
    <Atlas
      heading={
        <div className="flex items-baseline gap-1.5 text-sm whitespace-nowrap">
          <nav aria-label="Breadcrumb">
            <a
              href={DOCS_HOME}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm font-medium underline-offset-[3px] outline-none hover:underline focus-visible:ring-2"
            >
              Docs
            </a>
          </nav>
          <span className="text-muted-foreground" aria-hidden="true">
            /
          </span>
          <h1 className="text-sm font-semibold tracking-[-0.01em]">Architecture Atlas</h1>
        </div>
      }
    />
  );
}
