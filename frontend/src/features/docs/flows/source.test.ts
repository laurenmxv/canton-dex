// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { flows } from './catalog';
import { parseFlow, type FlowStep } from './source';

function flatten(steps: FlowStep[]): FlowStep[] {
  return steps.flatMap(step => [step, ...(step.kind === 'decision'
    ? step.branches.flatMap(branch => flatten(branch.steps))
    : step.kind === 'loop' || step.kind === 'group' ? flatten(step.steps) : [])]);
}

describe('the native flow source', () => {
  it.each(flows)('preserves every activity, decision and loop in $id', flow => {
    const document = parseFlow(flow);
    const steps = flatten(document.steps);
    expect(steps.filter(step => step.kind === 'activity').map(step => step.label)).toEqual(
      [...flow.source.matchAll(/^\s*:(.*);(?:\s*<<created>>)?\s*$/gm)].map(match => match[1]!.replaceAll('\\n', '\n')),
    );
    expect(steps.filter(step => step.kind === 'decision')).toHaveLength([...flow.source.matchAll(/^\s*if /gm)].length);
    expect(steps.filter(step => step.kind === 'loop')).toHaveLength([...flow.source.matchAll(/^\s*while /gm)].length);
    expect(new Set(steps.map(step => step.id)).size).toBe(steps.length);
    expect(steps.every(step => document.lanes.includes(step.lane))).toBe(true);
  });

  it('rejects unsupported statements with their source location', () => {
    expect(() => parseFlow({ id: 'test', title: 'Test', path: 'test.puml', source: '|Trader|\nstart\nfork\nstop' }))
      .toThrow('test.puml:3: Unsupported activity statement: fork');
  });

  it('rejects unfinished choices rather than dropping a branch', () => {
    expect(() => parseFlow({ id: 'test', title: 'Test', path: 'test.puml', source: '|Trader|\nif (Accept?) then (yes)\n:Accept;\nelse (no)\n:Reject;' }))
      .toThrow('Expected endif');
  });

  it('keeps withdrawal inside the pending proposal flow, with no separate section', () => {
    const document = parseFlow(flows.find(flow => flow.id === 'pool-creation')!);
    const steps = flatten(document.steps);
    const group = steps.find(step => step.kind === 'group');
    expect(group?.label).toContain('While pending');
    expect(group?.kind === 'group' && flatten(group.steps).some(step => step.label.includes('PoolProposal_Withdraw'))).toBe(true);
  });

  it('rejects unclosed groups at their source location', () => {
    expect(() => parseFlow({ id: 'test', title: 'Test', path: 'test.puml', source: '|Trader|\ngroup Optional {\n:Withdraw;\nstop' }))
      .toThrow('test.puml:2: Expected } to close the group.');
  });
});
