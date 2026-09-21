import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@openzeppelin/ui-components';
import { useId, type ReactNode } from 'react';

/**
 * Detail a reader can open when they want it, and ignore when they do not.
 *
 * One item, collapsible, so opening it is the only state it has and closing it
 * returns the screen to what it was.
 */
export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  const value = useId();
  return (
    <Accordion type="single" collapsible variant="card">
      <AccordionItem value={value} className="mb-0 rounded-md">
        <AccordionTrigger className="text-muted-foreground hover:text-foreground py-2 text-xs font-medium">
          {summary}
        </AccordionTrigger>
        <AccordionContent>
          <div className="flex flex-col gap-2 text-xs">{children}</div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
