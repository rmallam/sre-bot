import { parse, stringify } from 'yaml';
import { redactString, REDACTED } from './secret-patterns.js';

const SENSITIVE_KEYS = new Set([
  'stringData',
  'data',
  'password',
  'token',
  'secret',
  'apiKey',
  'api_key',
  'privateKey',
]);

export function redactYaml(content: string): { yaml: string; redactedKeys: string[] } {
  const redactedKeys: string[] = [];
  try {
    const doc = parse(content);
    walk(doc, [], redactedKeys);
    return { yaml: stringify(doc), redactedKeys };
  } catch {
    const { text, hits } = redactString(content);
    return { yaml: text, redactedKeys: hits };
  }
}

function walk(node: unknown, path: string[], redactedKeys: string[]): void {
  if (node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, [...path, String(i)], redactedKeys));
    return;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const keyPath = [...path, key].join('.');
    if (SENSITIVE_KEYS.has(key)) {
      (node as Record<string, unknown>)[key] = REDACTED;
      redactedKeys.push(keyPath);
      continue;
    }
    if (key === 'env' && Array.isArray(value)) {
      for (const envItem of value) {
        if (envItem && typeof envItem === 'object' && 'value' in envItem) {
          const v = (envItem as { value?: string }).value;
          if (typeof v === 'string' && v.length > 0) {
            (envItem as { value: string }).value = REDACTED;
            redactedKeys.push(`${keyPath}.value`);
          }
        }
      }
    }
    if (typeof value === 'string') {
      const { text, hits } = redactString(value);
      if (hits.length > 0) {
        (node as Record<string, unknown>)[key] = text;
        redactedKeys.push(...hits.map((h) => `${keyPath}:${h}`));
      }
    } else {
      walk(value, [...path, key], redactedKeys);
    }
  }
}
