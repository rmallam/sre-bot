/**
 * Normalize scraped K8s doc content into runbook corpus entries.
 */

import type { RunbookComponent, RunbookEntry } from './runbook-corpus.js';

export interface DocSeedSections {
  symptoms?: string[];
  diagnosis?: string[];
  remediation?: string[];
  verification?: string[];
  openshift_notes?: string[];
}

export interface K8sDocSource {
  error_signature: string;
  target_component: RunbookComponent;
  url: string;
  title: string;
  /** Pre-normalized sections — used when fetch is skipped or as override. */
  seed_sections?: DocSeedSections;
}

export interface K8sDocSourceCatalog {
  version: number;
  sources: K8sDocSource[];
}

export interface MergeRunbooksResult {
  added: RunbookEntry[];
  updated: RunbookEntry[];
  skipped: string[];
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function bulletBlock(items: string[] | undefined): string {
  if (!items?.length) return '';
  return items.map((line) => `- ${line.trim()}`).join('\n');
}

export function buildPlaybookMarkdown(opts: {
  title: string;
  sections: DocSeedSections;
  sourceUrl?: string;
}): string {
  const parts: string[] = [`# ${opts.title}`];
  if (opts.sections.symptoms?.length) {
    parts.push('', '## Symptoms', bulletBlock(opts.sections.symptoms));
  }
  if (opts.sections.diagnosis?.length) {
    parts.push('', '## Diagnosis', bulletBlock(opts.sections.diagnosis));
  }
  const remediation = [
    ...(opts.sections.remediation ?? []),
    ...(opts.sections.openshift_notes ?? []).map((n) => `(OpenShift) ${n}`),
  ];
  if (remediation.length) {
    parts.push('', '## Remediation', bulletBlock(remediation));
  }
  if (opts.sections.verification?.length) {
    parts.push('', '## Verification', bulletBlock(opts.sections.verification));
  }
  if (opts.sourceUrl) {
    parts.push('', `## Source`, `- ${opts.sourceUrl}`);
  }
  return parts.join('\n').trim();
}

/** Heuristic: pull list-like lines from scraped doc text into sections. */
export function extractSectionsFromText(text: string): DocSeedSections {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 20 && l.length < 500);

  const symptoms = lines.filter(
    (l) =>
      /crash|fail|error|backoff|pending|evict|denied|unable|not ready/i.test(l) &&
      !/^kubectl|^oc /i.test(l)
  );
  const diagnosis = lines.filter((l) => /^kubectl |^oc |describe |get |check |verify /i.test(l));
  const remediation = lines.filter(
    (l) => /fix|increase|decrease|patch|restart|create|delete|adjust|add |remove /i.test(l)
  );
  const verification = lines.filter(
    (l) => /ready|running|stable|success|resolved|no .* events/i.test(l)
  );

  return {
    symptoms: symptoms.slice(0, 5),
    diagnosis: diagnosis.slice(0, 6),
    remediation: remediation.slice(0, 5),
    verification: verification.slice(0, 4),
  };
}

export function sourceToRunbook(source: K8sDocSource, scrapedText?: string): RunbookEntry {
  const sections =
    source.seed_sections ??
    (scrapedText ? extractSectionsFromText(scrapedText) : { symptoms: [source.title] });

  const hasRequired =
    (sections.symptoms?.length ?? 0) > 0 &&
    (sections.diagnosis?.length ?? 0) > 0 &&
    (sections.verification?.length ?? 0) > 0;

  const filled: DocSeedSections = hasRequired
    ? sections
    : {
        symptoms: sections.symptoms?.length
          ? sections.symptoms
          : [`Workload shows ${source.error_signature} in events or pod status.`],
        diagnosis: sections.diagnosis?.length
          ? sections.diagnosis
          : [
              `oc describe pod -n <namespace> <pod>`,
              `oc get events -n <namespace> --field-selector involvedObject.name=<pod>`,
            ],
        remediation: sections.remediation?.length
          ? sections.remediation
          : [`Apply fix per ${source.title} guidance; prefer git_patch when manifest change is needed.`],
        verification: sections.verification?.length
          ? sections.verification
          : ['Pod Ready or condition cleared; no repeating failure events in 5m.'],
        openshift_notes: sections.openshift_notes,
      };

  return {
    error_signature: source.error_signature,
    target_component: source.target_component,
    playbook_markdown: buildPlaybookMarkdown({
      title: source.title,
      sections: filled,
      sourceUrl: source.url,
    }),
  };
}

export function mergeRunbooksIntoComponent(
  existing: RunbookEntry[],
  incoming: RunbookEntry[],
  force = false
): { merged: RunbookEntry[]; result: MergeRunbooksResult } {
  const byKey = new Map<string, RunbookEntry>();
  for (const rb of existing) {
    byKey.set(`${rb.target_component}::${rb.error_signature}`, rb);
  }

  const result: MergeRunbooksResult = { added: [], updated: [], skipped: [] };

  for (const rb of incoming) {
    const key = `${rb.target_component}::${rb.error_signature}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, rb);
      result.added.push(rb);
    } else if (force) {
      byKey.set(key, rb);
      result.updated.push(rb);
    } else {
      result.skipped.push(key);
    }
  }

  const merged = [...byKey.values()].sort((a, b) =>
    `${a.target_component}:${a.error_signature}`.localeCompare(
      `${b.target_component}:${b.error_signature}`
    )
  );
  return { merged, result };
}

export function taxonomyIdFromSignature(signature: string): string {
  return signature.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();
}
