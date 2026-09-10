import { describe, expect, it } from 'vitest';
import { schemaDepth, toOpenAiStrictSchema } from '../src/ai/openai-schema.js';
import { INTENT_JSON_SCHEMA } from '../src/ai/intent-schema.js';

/**
 * OpenAI strict mode rejects the whole request when it meets a keyword it does
 * not support, so these tests are the contract: whatever the canonical schema
 * grows, what leaves for OpenAI stays inside the subset.
 */

const UNSUPPORTED = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'default',
];

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const obj = node as Record<string, unknown>;
  visit(obj);
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'enum' || key === 'required') continue;
    walk(value, visit);
  }
}

describe('keyword stripping', () => {
  it('removes every unsupported validation keyword', () => {
    const adapted = toOpenAiStrictSchema(INTENT_JSON_SCHEMA);
    const found: string[] = [];
    walk(adapted, (node) => {
      for (const key of UNSUPPORTED) if (key in node) found.push(key);
    });
    expect(found).toEqual([]);
  });

  it('leaves the canonical schema untouched', () => {
    const before = JSON.stringify(INTENT_JSON_SCHEMA);
    toOpenAiStrictSchema(INTENT_JSON_SCHEMA);
    expect(JSON.stringify(INTENT_JSON_SCHEMA)).toBe(before);
  });

  it('keeps descriptions, which are what actually steer the model', () => {
    const adapted = toOpenAiStrictSchema({
      type: 'object',
      properties: { when: { type: ['string', 'null'], description: 'Local date YYYY-MM-DD' } },
      required: ['when'],
      additionalProperties: false,
    });
    const when = (adapted.properties as Record<string, Record<string, unknown>>).when!;
    expect(when.description).toBe('Local date YYYY-MM-DD');
  });
});

describe('nullable unions', () => {
  it('rewrites type unions as anyOf branches', () => {
    const adapted = toOpenAiStrictSchema({
      type: 'object',
      properties: { title: { type: ['string', 'null'] } },
      required: ['title'],
      additionalProperties: false,
    });
    const title = (adapted.properties as Record<string, Record<string, unknown>>).title!;
    expect(title.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
    expect(title.type).toBeUndefined();
  });

  it('lifts a null out of an enum into the union branch', () => {
    const adapted = toOpenAiStrictSchema({
      type: 'object',
      properties: { priority: { type: ['string', 'null'], enum: ['low', 'high', null] } },
      required: ['priority'],
      additionalProperties: false,
    });
    const priority = (adapted.properties as Record<string, Record<string, unknown>>).priority!;
    const branches = priority.anyOf as Record<string, unknown>[];
    expect(branches[0]).toEqual({ type: 'string', enum: ['low', 'high'] });
    expect(branches[1]).toEqual({ type: 'null' });
  });

  it('handles a nullable nested object', () => {
    const adapted = toOpenAiStrictSchema({
      type: 'object',
      properties: {
        task: {
          type: ['object', 'null'],
          properties: { title: { type: 'string' } },
          required: ['title'],
          additionalProperties: false,
        },
      },
      required: ['task'],
      additionalProperties: false,
    });
    const task = (adapted.properties as Record<string, Record<string, unknown>>).task!;
    const branches = task.anyOf as Record<string, unknown>[];
    expect(branches[0]!.type).toBe('object');
    expect(branches[0]!.additionalProperties).toBe(false);
    expect(branches[1]).toEqual({ type: 'null' });
  });

  it('leaves a plain non-nullable type alone', () => {
    const adapted = toOpenAiStrictSchema({
      type: 'object',
      properties: { flag: { type: 'boolean' } },
      required: ['flag'],
      additionalProperties: false,
    });
    expect((adapted.properties as Record<string, unknown>).flag).toEqual({ type: 'boolean' });
  });
});

describe('strict-mode object rules', () => {
  it('forces additionalProperties:false and full required on every object', () => {
    const adapted = toOpenAiStrictSchema(INTENT_JSON_SCHEMA);
    const problems: string[] = [];
    walk(adapted, (node) => {
      if (node.type !== 'object') return;
      if (node.additionalProperties !== false) problems.push('missing additionalProperties:false');
      const props = Object.keys((node.properties as Record<string, unknown>) ?? {});
      const required = (node.required as string[]) ?? [];
      const missing = props.filter((p) => !required.includes(p));
      if (missing.length) problems.push(`not required: ${missing.join(',')}`);
    });
    expect(problems).toEqual([]);
  });

  it('adds required for an object that omitted it', () => {
    const adapted = toOpenAiStrictSchema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      additionalProperties: false,
    });
    expect(adapted.required).toEqual(['a', 'b']);
  });

  it('rejects a non-object root, which strict mode does not allow', () => {
    expect(() => toOpenAiStrictSchema({ type: 'array', items: { type: 'string' } })).toThrow(
      /object at the root/,
    );
  });
});

describe('nesting budget', () => {
  it('stays within the 5-level limit', () => {
    expect(schemaDepth(toOpenAiStrictSchema(INTENT_JSON_SCHEMA))).toBeLessThanOrEqual(5);
  });
});

describe('the real intent schema survives the trip', () => {
  it('keeps every top-level field and its enum values', () => {
    const adapted = toOpenAiStrictSchema(INTENT_JSON_SCHEMA);
    const props = adapted.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props).sort()).toEqual(
      [
        'confidence',
        'event',
        'intent',
        'is_bulk',
        'query',
        'reasoning',
        'snooze',
        'task',
        'task_reference',
      ].sort(),
    );
    expect((props.intent!.enum as string[]).includes('CREATE_TASK')).toBe(true);
    expect(props.confidence).toEqual({ type: 'number' });
  });

  it('serialises to JSON without cycles or undefined', () => {
    const json = JSON.stringify(toOpenAiStrictSchema(INTENT_JSON_SCHEMA));
    expect(json).not.toContain('undefined');
    expect(JSON.parse(json)).toBeTruthy();
  });
});
