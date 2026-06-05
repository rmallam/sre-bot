/**
 * Helpers for interpreting deployment rollout / pod failure during verify waits.
 */

/** Pod or deployment message indicates a hard failure (not a transient rollout). */
export function isTerminalWorkloadFailure(message: string): boolean {
  return /ImagePullBackOff|CrashLoopBackOff|CreateContainerConfigError|InvalidImageName|ImageInspectError|CreateContainerError|RunContainerError|FailedMount/i.test(
    message
  );
}

/** First pull attempt failed — kube will retry; keep waiting until BackOff. */
export function isTransientImagePull(message: string): boolean {
  return /ErrImagePull|back-off pulling|pulling image/i.test(message) && !/ImagePullBackOff/i.test(message);
}

/** Deployment status still converging (new ReplicaSet, image pull, probes). */
export function isRolloutInProgress(input: {
  readyReplicas?: number;
  desiredReplicas?: number;
  updatedReplicas?: number;
  message?: string;
}): boolean {
  const desired = input.desiredReplicas ?? 0;
  if (desired <= 0) return false;
  const ready = input.readyReplicas ?? 0;
  const updated = input.updatedReplicas ?? ready;
  if (ready >= desired && updated >= desired) return false;
  if (input.message && isTerminalWorkloadFailure(input.message)) return false;
  return true;
}
