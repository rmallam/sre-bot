import type {
  DiagnosisContext,
  SanitizedFacts,
  SecurityFinding,
} from '../../../../shared/src/types.js';
import { redactString, highEntropyBase64, SECRET_PATTERNS } from './redactors/secret-patterns.js';
import { redactYaml } from './redactors/yaml-walker.js';

const BLOCK_ON_HIGH = (process.env['SECURITY_BLOCK_ON_FINDINGS'] ?? 'true').toLowerCase() === 'true';
const MAX_LOG_BYTES = parseInt(process.env['SECURITY_MAX_LOG_BYTES'] ?? '16384', 10);

export function sanitizeForLlm(
  context: DiagnosisContext,
  incidentId: string
): { sanitized: SanitizedFacts; findings: SecurityFinding[]; blocked: boolean } {
  const findings: SecurityFinding[] = [];

  const currentLogs = trimAndRedactLogs(context.currentLogs ?? '', findings);
  const previousLogs = trimAndRedactLogs(context.previousLogs ?? '', findings);

  let gitManifestContent = context.gitManifestContent;
  if (gitManifestContent) {
    const { yaml, redactedKeys } = redactYaml(gitManifestContent);
    gitManifestContent = yaml;
    for (const key of redactedKeys) {
      findings.push({
        type: 'manifest_redaction',
        field: key,
        severity: 'MEDIUM',
        action: 'redacted',
        message: `Redacted sensitive manifest field ${key}`,
      });
    }
  }

  const recentEvents = (context.recentEvents ?? []).map((ev) => {
    const { text, hits } = redactString(ev.message);
    for (const h of hits) {
      findings.push({
        type: h,
        field: 'recentEvents.message',
        severity: 'HIGH',
        action: 'redacted',
        message: `Redacted event message pattern ${h}`,
      });
    }
    return { ...ev, message: text };
  });

  if (highEntropyBase64(currentLogs + previousLogs)) {
    findings.push({
      type: 'high_entropy',
      field: 'logs',
      severity: 'HIGH',
      action: 'redacted',
      message: 'High-entropy blob detected in logs',
    });
  }

  const hasHigh = findings.some((f) => f.severity === 'HIGH');
  const blocked = BLOCK_ON_HIGH && hasHigh && findings.some((f) => f.action === 'blocked');

  const sanitized: SanitizedFacts = {
    ...context,
    incidentId,
    currentLogs,
    previousLogs,
    gitManifestContent,
    recentEvents,
    sanitizeBlocked: blocked,
    safeMode: true,
  };

  return { sanitized, findings, blocked };
}

export function sanitizeText(text: string): { text: string; findings: SecurityFinding[]; blocked: boolean } {
  const findings: SecurityFinding[] = [];
  let result = text;

  for (const { name, pattern, severity } of SECRET_PATTERNS) {
    if (pattern.test(result)) {
      findings.push({
        type: name,
        severity,
        action: 'redacted',
        message: `Redacted ${name} in user text`,
      });
      result = result.replace(new RegExp(pattern.source, pattern.flags), '[REDACTED]');
    }
    pattern.lastIndex = 0;
  }

  const blocked =
    BLOCK_ON_HIGH && findings.some((f) => f.severity === 'HIGH' && f.type === 'prompt_injection');

  return { text: result, findings, blocked };
}

function trimAndRedactLogs(raw: string, findings: SecurityFinding[]): string {
  let text = raw;
  if (text.length > MAX_LOG_BYTES) {
    text = text.slice(0, MAX_LOG_BYTES) + '\n...[truncated]';
    findings.push({
      type: 'log_truncation',
      field: 'logs',
      severity: 'LOW',
      action: 'removed',
      message: `Logs truncated to ${MAX_LOG_BYTES} bytes`,
    });
  }
  const { text: redacted, hits } = redactString(text);
  for (const h of hits) {
    findings.push({
      type: h,
      field: 'logs',
      severity: 'HIGH',
      action: 'redacted',
      message: `Redacted ${h} in logs`,
    });
  }
  return redacted;
}
