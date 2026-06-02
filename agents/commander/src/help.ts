/**
 * UX-12 — Stable help responses (no internal tool names).
 */

export const HELP_MESSAGE = `I'm your SRE assistant. Here's what I can help with:

**Cluster & workloads**
• "investigate cluster health" or "what's wrong with nginx in staging"
• "is httpd running in any namespace?" · "list pods in default"

**Deploy**
• "deploy github.com/org/repo to staging namespace"
• "deploy httpd in dev namespace"

**CI failures**
• "why did CI fail on github.com/org/repo?"
• Follow-ups: "show logs" · "retry" · "did it pass?" · "open the PR"

**Other**
• "delete nginx from staging" · "rollback nginx in staging"
• "be brief" / "more detail" to change how much detail I show

When I need your OK, use the **Approve** / **Reject** buttons or reply approve / reject.`;

/** Regex fast path for help — no LLM required. */
export function isHelpQuery(text: string): boolean {
  const t = text.trim();
  if (/^\/?help\b/i.test(t)) return true;
  return /\b(what can you do|how do i use (?:this|you|the bot)|what do you support|your capabilities|list commands|show commands)\b/i.test(
    t
  );
}
