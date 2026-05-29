/**
 * Turn internal errors into short operator-facing explanations (Telegram/Slack).
 */

export function humanizeOperatorError(raw: string | undefined): string {
  if (!raw?.trim()) return 'Something went wrong; check agent logs for details.';

  const msg = raw.trim();

  if (/spawn helm ENOENT/i.test(msg) || /helm ENOENT/i.test(msg)) {
    return (
      'Helm is not available in the gitops agent container, so the chart could not be installed. ' +
      'Rebuild the gitops image (helm was added to the Dockerfile) and try again.'
    );
  }

  if (/lfstack\.push|fatal error: lfstack/i.test(msg)) {
    return (
      'Helm crashed inside the container (often wrong CPU architecture on Mac/Podman). ' +
      'Rebuild gitops-agent — the image now uses kubectl-first deploy and the correct arch binaries.'
    );
  }

  if (/All deploy strategies failed/i.test(msg)) {
    return msg.split('\n')[0] ?? msg;
  }

  if (/spawn kubectl ENOENT/i.test(msg)) {
    return 'kubectl is not available in the gitops agent container.';
  }

  if (
    /cannot reach the kubernetes api/i.test(msg) ||
    /tls certificate does not match/i.test(msg) ||
    /x509: certificate is valid for/i.test(msg)
  ) {
    return (
      'The gitops agent cannot talk to your cluster API (TLS/host mismatch from inside Podman). ' +
      'Rebuild/restart agents so entrypoint sets insecure-skip-tls-verify, or set KUBE_API_HOST to your Podman Desktop API port.'
    );
  }

  if (/not retrying helm/i.test(msg) || /same cluster connection/i.test(msg)) {
    return msg.split('\n')[0] ?? msg;
  }

  if (/namespace.*not found/i.test(msg) || /namespaces? ["'][^"']+["'] not found/i.test(msg)) {
    return (
      'That namespace does not exist in the cluster yet. ' +
      'Reply **yes** when the bot asks to create it, or say "create namespace" to retry.'
    );
  }

  if (/404/.test(msg) && /deployment|namespace/i.test(msg)) {
    return (
      'Nothing is running yet in that namespace — the deploy step probably did not succeed. ' +
      'Fix the error below and redeploy.'
    );
  }

  if (/Remote branch .+ not found/i.test(msg)) {
    return 'Git branch not found on the remote; try another branch (e.g. develop or master).';
  }

  if (msg.startsWith('Error: ')) {
    return msg.slice(7);
  }

  return msg.length > 400 ? `${msg.slice(0, 400)}…` : msg;
}
