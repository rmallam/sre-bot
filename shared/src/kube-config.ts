/**
 * Single Kubernetes client bootstrap (PLAT-14).
 * In-cluster SA → KUBECONFIG file → default kubeconfig.
 */

import * as k8s from '@kubernetes/client-node';
import { existsSync } from 'node:fs';

export function buildKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();

  if (existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')) {
    try {
      kc.loadFromCluster();
      return kc;
    } catch {
      /* fall through */
    }
  }

  const kubeconfig = process.env['KUBECONFIG'] ?? `${process.env['HOME'] ?? '/root'}/.kube/config`;
  if (existsSync(kubeconfig)) {
    kc.loadFromFile(kubeconfig, true);
    return kc;
  }

  kc.loadFromDefault();
  return kc;
}
