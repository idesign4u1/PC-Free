/**
 * Adapts our canonical JSON Schema to OpenAI's strict Structured Outputs
 * dialect.
 *
 * The canonical schema (ai/intent-schema.ts) is written for expressiveness:
 * it carries numeric ranges, string formats and nullable unions, all of which
 * Anthropic accepts and which document the contract. OpenAI's strict mode is
 * a deliberately small subset and **rejects the request** when it sees a
 * keyword it does not support, so the schema has to be rewritten on the way
 * out:
 *
 *   - Validation keywords that strict mode does not enforce (minimum, maximum,
 *     minLength, pattern, format, minItems, …) are dropped. They are not lost
 *     as guarantees: every response is still validated with Zod afterwards, so
 *     the constraint is enforced in our code rather than by the provider.
 *   - Nullable unions `type: ["string", "null"]` become
 *     `anyOf: [{type: "string"}, {type: "null"}]`, which is the form strict
 *     mode documents for optional fields.
 *   - An enum listing `null` alongside its values has the null lifted out into
 *     the anyOf branch, because an enum member must match the branch's type.
 *   - Every object gets `additionalProperties: false` and a `required` array
 *     listing all of its properties, which strict mode demands.
 *
 * Descriptions are preserved throughout: they are the part of the schema that
 * actually steers the model.
 */

/** Keywords strict Structured Outputs does not accept. */
const UNSUPPORTED_KEYWORDS = new Set([
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
  'uniqueItems',
  'default',
  'examples',
  'contentEncoding',
  'contentMediaType',
]);

type JsonSchema = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rewrites one schema node. Returns the adapted node; nullability is expressed
 * by the caller-visible `anyOf` wrapper this may produce.
 */
function adaptNode(node: unknown): unknown {
  if (!isPlainObject(node)) return node;

  const out: JsonSchema = {};
  let types: string[] | null = null;

  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;

    if (key === 'type') {
      types = Array.isArray(value) ? value.map(String) : [String(value)];
      continue;
    }
    if (key === 'properties' && isPlainObject(value)) {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, adaptNode(v)]));
      continue;
    }
    if (key === 'items') {
      out.items = adaptNode(value);
      continue;
    }
    if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      out[key] = Array.isArray(value) ? value.map(adaptNode) : adaptNode(value);
      continue;
    }
    out[key] = value;
  }

  if (!types) return out;

  const nullable = types.includes('null');
  const concrete = types.filter((t) => t !== 'null');

  // An enum that carries `null` as a member: the null belongs in the union
  // branch, not in the enum list.
  if (Array.isArray(out.enum)) {
    const values = (out.enum as unknown[]).filter((v) => v !== null);
    out.enum = values;
  }

  const buildBranch = (type: string): JsonSchema => {
    const branch: JsonSchema = { ...out, type };
    if (type === 'object') {
      branch.additionalProperties = false;
      // Strict mode requires every declared property to be listed as required.
      const properties = isPlainObject(branch.properties) ? branch.properties : {};
      branch.required = Object.keys(properties);
    }
    if (type !== 'string' && type !== 'number' && type !== 'integer') delete branch.enum;
    return branch;
  };

  // `description` belongs on the wrapper so it survives the union.
  const description = typeof out.description === 'string' ? out.description : undefined;

  if (!nullable) {
    const branch = buildBranch(concrete[0] ?? 'string');
    if (concrete.length > 1) {
      const wrapper: JsonSchema = { anyOf: concrete.map(buildBranch) };
      if (description) wrapper.description = description;
      return wrapper;
    }
    return branch;
  }

  const branches = concrete.map(buildBranch);
  branches.forEach((b) => delete b.description);
  branches.push({ type: 'null' });

  const wrapper: JsonSchema = { anyOf: branches };
  if (description) wrapper.description = description;
  return wrapper;
}

/**
 * Converts a canonical schema into one OpenAI strict mode accepts.
 * The root must be a plain object schema — strict mode requires it.
 */
export function toOpenAiStrictSchema(schema: JsonSchema): JsonSchema {
  const adapted = adaptNode(schema);
  if (!isPlainObject(adapted)) throw new Error('Root schema must be an object schema');
  if (adapted.type !== 'object') {
    throw new Error(
      'OpenAI strict Structured Outputs requires an object at the root of the schema',
    );
  }
  return adapted;
}

/** Nesting depth, so we can fail loudly rather than hit OpenAI's 5-level cap. */
export function schemaDepth(node: unknown, depth = 0): number {
  if (!isPlainObject(node)) return depth;
  let max = depth;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && isPlainObject(value)) {
      for (const child of Object.values(value)) max = Math.max(max, schemaDepth(child, depth + 1));
    } else if (key === 'items') {
      max = Math.max(max, schemaDepth(value, depth + 1));
    } else if ((key === 'anyOf' || key === 'oneOf') && Array.isArray(value)) {
      for (const child of value) max = Math.max(max, schemaDepth(child, depth));
    }
  }
  return max;
}
