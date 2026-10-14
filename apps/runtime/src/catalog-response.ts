import { RuntimeError } from '@iris/domain';
import { redactStructuredValue } from './output-redaction.js';

const MAX_BYTES = 256 * 1024;
const MAX_NODES = 16384;
const MAX_DEPTH = 32;
const SCHEMA_KEYS = new Set(['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'oneOf', 'anyOf', 'allOf', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'pattern', 'format', 'default', 'title', '$ref', '$defs']);

/** Only server-constructed catalogs enter here; request arguments and tool output must use Safe-Output. */
export function serializeToolCatalog(id: unknown, tools: readonly unknown[]): string {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const reject = (): never => { throw new RuntimeError('INVALID_REQUEST', 'Invalid server tool catalog'); };
  function visit(value: unknown, depth: number): void {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) reject();
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value, 'utf8');
      if (bytes > MAX_BYTES) reject();
      return;
    }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
    if (typeof value !== 'object' || value === undefined || ancestors.has(value)) reject();
    const object = value as object;
    const prototype = Object.getPrototypeOf(object);
    if (!Array.isArray(object) && prototype !== Object.prototype && prototype !== null) reject();
    ancestors.add(object);
    if (Array.isArray(object) && object.length > MAX_NODES) reject();
    const descriptors = Object.getOwnPropertyDescriptors(object);
    if (Reflect.ownKeys(object).some((key) => typeof key !== 'string')) reject();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(object) && key === 'length') continue;
      if (Array.isArray(object) && !/^(0|[1-9][0-9]*)$/.test(key)) reject();
      if (!descriptor.enumerable || !('value' in descriptor) || key === '__proto__' || key === 'constructor' || key === 'prototype') reject();
      bytes += Buffer.byteLength(key, 'utf8');
      if (bytes > MAX_BYTES) reject();
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(object);
  }
  visit(tools, 0);
  if (!Array.isArray(tools) || tools.length > 128) reject();
  const names = new Set<string>();
  for (const tool of tools) {
    if (!record(tool) || Object.keys(tool).some((key) => !['name', 'description', 'inputSchema', 'annotations'].includes(key))) reject();
    const definition = tool as Record<string, unknown>;
    if (typeof definition.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(definition.name) || names.has(definition.name)) reject();
    if (definition.description !== undefined && typeof definition.description !== 'string') reject();
    names.add(definition.name as string);
    schema(definition.inputSchema);
    if (definition.annotations !== undefined) {
      if (!record(definition.annotations) || Object.entries(definition.annotations).some(([key, value]) => !['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].includes(key) || typeof value !== 'boolean')) reject();
    }
  }
  function schema(value: unknown): void {
    if (!record(value)) reject();
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!SCHEMA_KEYS.has(key)) reject();
      if (['description', 'pattern', 'format', 'title', '$ref'].includes(key) && typeof item !== 'string') reject();
      if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'].includes(key) && (typeof item !== 'number' || !Number.isFinite(item))) reject();
      if (key === 'uniqueItems' && typeof item !== 'boolean') reject();
      if (key === 'required' && (!Array.isArray(item) || item.some((entry) => typeof entry !== 'string'))) reject();
      if (key === 'enum' && (!Array.isArray(item) || item.length === 0)) reject();
      if (key === 'type') {
        const types = Array.isArray(item) ? item : [item];
        if (types.length === 0 || types.some((entry) => !['null', 'boolean', 'object', 'array', 'number', 'integer', 'string'].includes(entry))) reject();
      }
      if (key === 'properties' || key === '$defs') {
        if (!record(item)) reject();
        for (const child of Object.values(item as Record<string, unknown>)) schema(child);
      } else if (key === 'items' || (key === 'additionalProperties' && typeof item !== 'boolean')) schema(item);
      else if (key === 'oneOf' || key === 'anyOf' || key === 'allOf') {
        if (!Array.isArray(item)) reject();
        for (const child of item as unknown[]) schema(child);
      }
    }
  }
  // The correlation ID is request-controlled and never inherits catalog trust.
  const safeId = typeof id === 'string' ? redactStructuredValue(id.slice(0, 1024)) : typeof id === 'number' && Number.isFinite(id) ? id : null;
  const encoded = JSON.stringify({ jsonrpc: '2.0', id: safeId, result: { tools } });
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BYTES) reject();
  return encoded;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
