import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRODUCT_NAME } from '@cold-reserve/i18n';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_INTENTS, INTENT_TOOLS } from '../src/index.js';

// Lint of the skill package against Amazon's invocation-name and sample rules, and against the handler's table:
// an intent the model has but the handler does not map (or the reverse) fails here, not in the console.
const PACKAGE = join(import.meta.dirname, '..', 'skill-package');
const read = (path: string): unknown => JSON.parse(readFileSync(join(PACKAGE, path), 'utf8'));

interface Intent {
  name: string;
  slots?: unknown[];
  samples: string[];
}
const model = read('interactionModels/custom/en-US.json') as { interactionModel: { languageModel: { invocationName: string; intents: Intent[]; types: unknown[] } } };
const manifest = read('skill.json') as { manifest: { publishingInformation: { locales: Record<string, { name: string; examplePhrases: string[] }> }; apis: { custom: { endpoint: { uri: string } } } } };
const { invocationName, intents, types } = model.interactionModel.languageModel;

/** Launch phrases, connecting words and wake words an invocation name may not contain (Amazon's rules). */
const FORBIDDEN_WORDS = ['alexa', 'amazon', 'echo', 'computer', 'skill', 'app', 'launch', 'ask', 'tell', 'load', 'begin', 'enable', 'open', 'start', 'play', 'resume', 'run', 'use', 'to', 'from', 'by', 'if', 'and', 'whether'];

describe('the interaction model', () => {
  it('has the invocation name "safe eight sound": lowercase letters, spaces, apostrophes and periods only, numbers in words', () => {
    expect(invocationName).toBe('safe eight sound');
    expect(invocationName).toMatch(/^[a-z' .]+$/);
    expect(invocationName.split(' ').length).toBeGreaterThanOrEqual(2);
    for (const word of invocationName.split(' ')) expect(FORBIDDEN_WORDS).not.toContain(word);
  });

  it('maps every custom intent to a tool, and every tool request has its intent', () => {
    const custom = intents.filter((i) => !i.name.startsWith('AMAZON.')).map((i) => i.name);
    const mapped = Object.keys(INTENT_TOOLS).filter((k) => k !== 'LaunchRequest');
    expect(custom.sort()).toEqual(mapped.sort());
  });

  it('declares exactly the built-in intents the handler answers', () => {
    expect(intents.filter((i) => i.name.startsWith('AMAZON.')).map((i) => i.name).sort()).toEqual([...BUILT_IN_INTENTS].sort());
  });

  it('has no slots and no custom types', () => {
    for (const i of intents) expect(i.slots ?? []).toEqual([]);
    expect(types).toEqual([]);
  });

  it('has samples that are lowercase words without digits, unique across intents, and never a launch phrase', () => {
    const all = intents.flatMap((i) => i.samples);
    expect(new Set(all).size).toBe(all.length);
    for (const sample of all) {
      expect(sample).toMatch(/^[a-z' ]+$/);
      expect(sample).not.toMatch(/^(ask|tell|open|launch|start|alexa)\b/);
      expect(sample).not.toContain(invocationName);
    }
    for (const i of intents.filter((x) => !x.name.startsWith('AMAZON.'))) expect(i.samples.length).toBeGreaterThanOrEqual(8);
  });
});

describe('the skill manifest', () => {
  it('shows the product name, and its example phrases use the invocation name', () => {
    const enUs = manifest.manifest.publishingInformation.locales['en-US'];
    expect(enUs?.name).toBe(PRODUCT_NAME);
    for (const phrase of enUs?.examplePhrases ?? []) expect(phrase).toContain(`Alexa, `);
    for (const phrase of enUs?.examplePhrases ?? []) expect(phrase).toContain(invocationName);
  });

  it('carries a placeholder endpoint only: the real function ARN and skill ID are never in the repo', () => {
    expect(manifest.manifest.apis.custom.endpoint.uri).toContain(':000000000000:');
    expect(JSON.stringify(manifest)).not.toMatch(/amzn1\.ask\.skill\./);
  });
});
