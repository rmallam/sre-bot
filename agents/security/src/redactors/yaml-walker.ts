import { parse, stringify } from 'yaml';
import { redactString, REDACTED } from './secret-patterns.js';

const SENSITIVE_KEY_RE =
  /^(stringdata|data|password|token|secret|apikey|api_key|privatekey|accesstoken|clientsecret|credentials|authorization)$/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

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

function redactEnvValue(envItem: Record<string, unknown>, keyPath: string, redactedKeys: string[]): void {
  if ('value' in envItem && typeof envItem['value'] === 'string' && envItem['value'].length > 0) {
    envItem['value'] = REDACTED;
    redactedKeys.push(`${keyPath}.value`);
  }
  const valueFrom = envItem['valueFrom'];
  if (valueFrom && typeof valueFrom === 'object') {
    const vf = valueFrom as Record<string, unknown>;
    if (vf['secretKeyRef'] || vf['configMapKeyRef']) {
      envItem['valueFrom'] = REDACTED;
      redactedKeys.push(`${keyPath}.valueFrom`);
    }
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
    if (isSensitiveKey(key)) {
      (node as Record<string, unknown>)[key] = REDACTED;
      redactedKeys.push(keyPath);
      continue;
    }
    if (key === 'env' && Array.isArray(value)) {
      for (const envItem of value) {
        if (envItem && typeof envItem === 'object') {
          redactEnvValue(envItem as Record<string, unknown>, keyPath, redactedKeys);
        }
      }
    }
    if (key === 'envFrom' && Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (item && typeof item === 'object') {
          (value as unknown[])[i] = REDACTED;
          redactedKeys.push(`${keyPath}.${i}`);
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
