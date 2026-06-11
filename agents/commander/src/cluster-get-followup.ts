/**
 * Follow-up when user asks to expand a truncated cluster resource listing.
 */

/** True for short replies like "more detail", "show all", "full list". */
export function isClusterListExpandFollowUp(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t || t.length > 80) return false;
  return /\b(more detail|full list|show (me )?(all|more|full|everything|the rest)|expand( the list)?|list (them )?all)\b/.test(
    t
  );
}
