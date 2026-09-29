// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flows } from './catalog';

// Tests run from frontend/; the sources live in the repository docs.
const repo = join(process.cwd(), '..');

describe('the Daml flow catalogue', () => {
  it('lists the five flows in reading order with the titles their sources declare', () => {
    expect(flows.map((flow) => [flow.id, flow.title])).toEqual([
      ['onboarding', 'Onboarding'],
      ['pool-creation', 'Pool creation'],
      ['pool-swap', 'Pool swap'],
      ['pool-provide-liquidity', 'Provide liquidity'],
      ['pool-withdraw-liquidity', 'Withdraw Liquidity'],
    ]);
  });

  it('serves each flow exactly as its PlantUML source file', () => {
    for (const flow of flows) {
      const file = readFileSync(join(repo, flow.path), 'utf8');
      expect(flow.source, flow.path).toBe(file);
      expect(file.split('\n')[0], flow.path).toBe(`@startuml ${flow.id}`);
      expect(file.trimEnd().endsWith('@enduml'), flow.path).toBe(true);
    }
  });
});
