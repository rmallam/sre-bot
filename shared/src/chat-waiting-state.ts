/**
 * Web chat waitingForRun session flag helpers.
 */

export interface ChatTurnLike {
  liveUpdate?: boolean;
}

export interface ChatSessionWaitingState {
  waitingForRun?: boolean;
  lastRunId?: string;
  transcript?: ChatTurnLike[];
}

/** Clear stale waitingForRun when thinking finished but no orchestrator run exists. */
export function recoverWaitingForRun(session: ChatSessionWaitingState | undefined): boolean {
  let waitingForRun = session?.waitingForRun ?? false;
  if (waitingForRun && !session?.lastRunId) {
    const hasLive = session?.transcript?.some((t) => t.liveUpdate);
    if (!hasLive) waitingForRun = false;
  }
  return waitingForRun;
}

export interface ChatTurnClearLike {
  role: string;
  incidentId?: string;
  liveUpdate?: boolean;
}

/** Transcript after clearing web thinking / live status bubbles. */
export function filterTranscriptAfterClear(
  transcript: ChatTurnClearLike[],
  incidentId: string
): ChatTurnClearLike[] {
  if (incidentId === 'pending') {
    return transcript.filter((t) => t.role !== 'status' && !t.liveUpdate);
  }
  return transcript.filter(
    (t) =>
      !(t.role === 'status' && t.incidentId === incidentId) &&
      !(t.liveUpdate && t.incidentId === incidentId)
  );
}
