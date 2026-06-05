/**
 * Guards for case resume — only treat messages as case hints when they clearly continue
 * the active remediation thread, not when the user starts a new command or asks a question.
 */

import { looksLikeImageRemediation } from './investigate-target.js';

/** User is starting a different command (deploy, get, cancel, etc.). */
export function looksLikeNewCommand(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^\//.test(t)) return true;
  if (/^(cancel|stop|abort|nevermind|never mind|no thanks)\b/i.test(t)) return true;
  if (/\b(deploy|rollback|undeploy|uninstall|delete|remove)\b/i.test(t)) return true;
  if (/\b(get|list|show|display)\s+(all\s+)?(pods|namespaces|deployments|nodes|services|events)\b/i.test(t)) {
    return true;
  }
  if (/\bci[- ]?(fail|failure|status|triage)\b/i.test(t)) return true;
  if (/\bhelp\b/i.test(t) && t.length < 80) return true;
  return false;
}

/** Complaint or meta question — route to chat / pending-run handler, not case hint. */
export function looksLikeUserMetaQuestion(text: string): boolean {
  return (
    /\b(can't see|cannot see|don't see|do not see|nothing there|not showing|where is|what happened|why am i|same again|still waiting|no approval|no button)\b/i.test(
      text
    ) || /\?\s*$/.test(text.trim())
  );
}

/** Message likely adds operator context to the open case (image tag, retry, etc.). */
export function looksLikeCaseContinuation(text: string): boolean {
  if (looksLikeImageRemediation(text)) return true;
  if (/\b(try again|retry|re-?run|same fix|continue|go ahead|approve|reject)\b/i.test(text)) {
    return true;
  }
  if (/\b(tag|version|registry|ghcr|image pull|pullbackoff|wrong image)\b/i.test(text)) {
    return true;
  }
  if (/\bset image\b/i.test(text)) return true;
  return false;
}

export function shouldResumeCaseWithHint(text: string): boolean {
  if (looksLikeNewCommand(text)) return false;
  if (looksLikeUserMetaQuestion(text)) return false;
  return looksLikeCaseContinuation(text);
}
