import { Button } from '@openzeppelin/ui-components';
import { useEffect, useMemo, useState } from 'react';
import { Card } from '../../../ui/Card';
import { ErrorState } from '../../../ui/States';
import { DOCS_HOME, flowHash, flowIdOf, isFlowsHash } from '../routes';
import { flows, type DamlFlow } from './catalog';
import { Diagram } from './Diagram';
import { parseFlow } from './source';

/** The flow the URL names, kept in step with hash changes; an unknown id shows the first flow. */
function useFlow(): DamlFlow {
  const [id, setId] = useState(() => flowIdOf(window.location.hash));
  useEffect(() => {
    const sync = () => {
      if (isFlowsHash(window.location.hash)) setId(flowIdOf(window.location.hash));
    };
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);
  const flow = flows.find((item) => item.id === id) ?? flows[0]!;
  // An unknown id shows the first flow, and the URL says so without adding a history entry.
  useEffect(() => {
    const { hash, pathname, search } = window.location;
    const named = flowIdOf(hash);
    if (isFlowsHash(hash) && named && named !== flow.id) window.history.replaceState(null, '', pathname + search + flowHash(flow.id));
  }, [flow.id, id]);
  return flow;
}

/** The Daml flow diagrams, rendered in the browser from `docs/flows/*.puml`. */
export function FlowsPage() {
  const flow = useFlow();
  const parsed = useMemo(() => {
    try { return { document: parseFlow(flow) }; }
    catch (error) { return { error: error instanceof Error ? error : new Error(String(error)) }; }
  }, [flow]);
  return (
    <div className="daml-flows bg-surface flex min-h-0 flex-1 flex-col">
      <header className="bg-card flex min-h-12 flex-none flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b px-4 py-1.5">
        <div className="flex items-baseline gap-1.5 text-sm whitespace-nowrap">
          <nav aria-label="Breadcrumb">
            <a
              href={DOCS_HOME}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm font-medium underline-offset-[3px] outline-none hover:underline focus-visible:ring-2"
            >
              Docs
            </a>
          </nav>
          <span className="text-muted-foreground" aria-hidden="true">/</span>
          <h1 className="text-sm font-semibold tracking-[-0.01em]">Daml flows</h1>
        </div>
        <nav className="flex flex-wrap items-center gap-1" aria-label="Flows">
          {flows.map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant={item.id === flow.id ? 'default' : 'ghost'}
              aria-current={item.id === flow.id ? 'page' : undefined}
              onClick={() => { window.location.hash = flowHash(item.id); }}
            >
              {item.title}
            </Button>
          ))}
        </nav>
      </header>
      {parsed.document ? (
        <Diagram key={flow.id} flow={flow} document={parsed.document} />
      ) : (
        <div className="p-4">
          <Card padded>
            <ErrorState error={parsed.error!} />
          </Card>
        </div>
      )}
    </div>
  );
}
