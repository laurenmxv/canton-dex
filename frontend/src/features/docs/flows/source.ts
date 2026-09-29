import type { DamlFlow } from './catalog';

interface StepBase { id: string; lane: string; label: string }
export type FlowStep = StepBase & (
  | { kind: 'activity'; created: boolean }
  | { kind: 'start' | 'stop' | 'detach' | 'arrow' }
  | { kind: 'decision'; branches: { label: string; steps: FlowStep[] }[] }
  | { kind: 'loop'; yes: string; no: string; steps: FlowStep[] }
  | { kind: 'group'; steps: FlowStep[] }
);
export interface FlowDocument { lanes: string[]; steps: FlowStep[] }
const clean = (text: string) => text.replaceAll('\\n', '\n');

/** The activity syntax used by our five sources. Unsupported statements fail instead of disappearing. */
export function parseFlow(flow: DamlFlow): FlowDocument {
  const lines = flow.source.replace(/<style>[\s\S]*?<\/style>/g, block => block.replace(/[^\n]/g, ''))
    .split(/\r?\n/).map((text, index) => ({ text: text.trim(), line: index + 1 }))
    .filter(({ text }) => text && !/^(?:@startuml(?:\s|$)|@enduml$|title\s|skinparam(?:locked)?\s)/.test(text));
  const lanes: string[] = [];
  let cursor = 0, serial = 0, lane = '';
  const fail = (message: string, line = lines[cursor - 1]?.line) => {
    throw new Error(`${flow.path}${line ? `:${line}` : ''}: ${message}`);
  };
  const base = (label = ''): StepBase => {
    if (!lane) fail('A step needs a swim lane.');
    return { id: `${flow.id}-${++serial}`, lane, label: clean(label) };
  };
  function block(until: RegExp = /$^/): FlowStep[] {
    const steps: FlowStep[] = [];
    while (cursor < lines.length) {
      const { text, line } = lines[cursor]!;
      if (until.test(text)) break;
      cursor += 1;
      let match: RegExpExecArray | null;
      if ((match = /^\|(?:#[\da-fA-F]+\|)?([^|]+)\|$/.exec(text))) {
        lane = clean(match[1]!);
        if (!lanes.includes(lane)) lanes.push(lane);
      } else if ((match = /^:(.*);(?:\s*<<created>>)?$/.exec(text))) {
        steps.push({ ...base(match[1]), kind: 'activity', created: text.endsWith('<<created>>') });
      } else if (text === 'start' || text === 'stop' || text === 'detach') {
        steps.push({ ...base(), kind: text });
      } else if ((match = /^-> (.*);$/.exec(text))) {
        steps.push({ ...base(match[1]), kind: 'arrow' });
      } else if ((match = /^if \((.*)\) then \((.*)\)$/.exec(text))) {
        const decision = base(match[1]);
        const first = block(/^(?:else\s|endif$)/);
        const otherwise = /^else \((.*)\)$/.exec(lines[cursor]?.text ?? '');
        if (!otherwise) fail('Expected an explicit else branch.', line);
        cursor += 1;
        const second = block(/^endif$/);
        if (lines[cursor]?.text !== 'endif') fail('Expected endif.', line);
        cursor += 1;
        steps.push({ ...decision, kind: 'decision', branches: [
          { label: clean(match[2]!), steps: first }, { label: clean(otherwise![1]!), steps: second },
        ] });
      } else if ((match = /^group (.+) \{$/.exec(text))) {
        const group = base(match[1]);
        const body = block(/^\}$/);
        if (lines[cursor]?.text !== '}') fail('Expected } to close the group.', line);
        if (!body.length) fail('A group needs steps.', line);
        cursor += 1;
        steps.push({ ...group, kind: 'group', steps: body });
      } else if ((match = /^while \((.*)\) is \((.*)\)$/.exec(text))) {
        const loop = base(match[1]);
        const body = block(/^endwhile\s/);
        const end = /^endwhile \((.*)\)$/.exec(lines[cursor]?.text ?? '');
        if (!end) fail('Expected endwhile with an exit label.', line);
        cursor += 1;
        steps.push({ ...loop, kind: 'loop', steps: body, yes: clean(match[2]!), no: clean(end![1]!) });
      } else fail(`Unsupported activity statement: ${text}`, line);
    }
    return steps;
  }
  const steps = block();
  if (!steps.length) fail('The diagram has no steps.');
  return { lanes, steps };
}
