/**
 * RAG advisory replies for procedural SRE questions (no cluster mutation).
 */

import { platformRagQuery, ragGroundingEnabled } from '../../../shared/src/platform-client.js';
import type { SreTaskClassification } from '../../../shared/src/sre/sre-task-classifier.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'commander-sre-rag';

export async function trySreRagAdvisoryReply(opts: {
  text: string;
  classification: SreTaskClassification;
  incidentId: string;
}): Promise<string | null> {
  if (!opts.classification.advisoryOnly || opts.classification.handler !== 'rag') {
    return null;
  }
  if (!ragGroundingEnabled()) {
    return (
      `**${opts.classification.ragSignature ?? opts.classification.scenario}** — ` +
      `RAG runbooks are available when platform-agent is connected. ` +
      `Try: investigate a specific workload, or ask after enabling SRE_RAG_GROUNDING.`
    );
  }

  const rag = await platformRagQuery({
    queryText: opts.text,
    errorSignature: opts.classification.ragSignature ?? '',
    targetComponent: opts.classification.ragComponent ?? 'compute',
    topK: 2,
    maxChars: 3500,
    incidentId: opts.incidentId,
  });

  if (!rag?.found || !rag.combinedMarkdown.trim()) {
    log('info', AGENT, 'No RAG hit for advisory query', {
      incidentId: opts.incidentId,
      scenario: opts.classification.scenario,
    });
    return null;
  }

  return `📚 **Runbook** (${opts.classification.scenario})\n\n${rag.combinedMarkdown.trim()}`;
}
