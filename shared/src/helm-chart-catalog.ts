/**
 * Well-known Helm charts for "deploy argocd" style commands (no Git repo).
 */

import type { RemoteHelmInstall } from './deploy/readme-install-hints.js';

export interface HelmCatalogEntry {
  id: string;
  aliases: string[];
  remote: RemoteHelmInstall;
  defaultNamespace: string;
  releaseName: string;
}

const ENTRIES: HelmCatalogEntry[] = [
  {
    id: 'argocd',
    aliases: ['argocd', 'argo-cd', 'argo'],
    remote: {
      repoName: 'argo',
      repoUrl: 'https://argoproj.github.io/argo-helm',
      chartRef: 'argo/argo-cd',
      releaseName: 'argocd',
    },
    defaultNamespace: 'argocd',
    releaseName: 'argocd',
  },
  {
    id: 'redis',
    aliases: ['redis'],
    remote: {
      repoName: 'bitnami',
      repoUrl: 'https://charts.bitnami.com/bitnami',
      chartRef: 'bitnami/redis',
      releaseName: 'redis',
    },
    defaultNamespace: 'redis',
    releaseName: 'redis',
  },
  {
    id: 'postgresql',
    aliases: ['postgresql', 'postgres'],
    remote: {
      repoName: 'bitnami',
      repoUrl: 'https://charts.bitnami.com/bitnami',
      chartRef: 'bitnami/postgresql',
      releaseName: 'postgresql',
    },
    defaultNamespace: 'postgresql',
    releaseName: 'postgresql',
  },
  {
    id: 'mysql',
    aliases: ['mysql'],
    remote: {
      repoName: 'bitnami',
      repoUrl: 'https://charts.bitnami.com/bitnami',
      chartRef: 'bitnami/mysql',
      releaseName: 'mysql',
    },
    defaultNamespace: 'mysql',
    releaseName: 'mysql',
  },
  {
    id: 'mariadb',
    aliases: ['mariadb'],
    remote: {
      repoName: 'bitnami',
      repoUrl: 'https://charts.bitnami.com/bitnami',
      chartRef: 'bitnami/mariadb',
      releaseName: 'mariadb',
    },
    defaultNamespace: 'mariadb',
    releaseName: 'mariadb',
  },
  {
    id: 'mongodb',
    aliases: ['mongodb', 'mongo'],
    remote: {
      repoName: 'bitnami',
      repoUrl: 'https://charts.bitnami.com/bitnami',
      chartRef: 'bitnami/mongodb',
      releaseName: 'mongodb',
    },
    defaultNamespace: 'mongodb',
    releaseName: 'mongodb',
  },
  {
    id: 'kafka',
    aliases: ['kafka'],
    remote: {
      repoName: 'bitnami',
      repoUrl: 'https://charts.bitnami.com/bitnami',
      chartRef: 'bitnami/kafka',
      releaseName: 'kafka',
    },
    defaultNamespace: 'kafka',
    releaseName: 'kafka',
  },
  {
    id: 'rabbitmq',
    aliases: ['rabbitmq'],
    remote: {
      repoName: 'bitnami',
      repoUrl: 'https://charts.bitnami.com/bitnami',
      chartRef: 'bitnami/rabbitmq',
      releaseName: 'rabbitmq',
    },
    defaultNamespace: 'rabbitmq',
    releaseName: 'rabbitmq',
  },
  {
    id: 'minio',
    aliases: ['minio'],
    remote: {
      repoName: 'bitnami',
      repoUrl: 'https://charts.bitnami.com/bitnami',
      chartRef: 'bitnami/minio',
      releaseName: 'minio',
    },
    defaultNamespace: 'minio',
    releaseName: 'minio',
  },
  {
    id: 'prometheus',
    aliases: ['prometheus'],
    remote: {
      repoName: 'prometheus-community',
      repoUrl: 'https://prometheus-community.github.io/helm-charts',
      chartRef: 'prometheus-community/prometheus',
      releaseName: 'prometheus',
    },
    defaultNamespace: 'monitoring',
    releaseName: 'prometheus',
  },
  {
    id: 'kube-prometheus-stack',
    aliases: ['kube-prometheus-stack', 'prometheus-stack', 'monitoring-stack'],
    remote: {
      repoName: 'prometheus-community',
      repoUrl: 'https://prometheus-community.github.io/helm-charts',
      chartRef: 'prometheus-community/kube-prometheus-stack',
      releaseName: 'kube-prometheus-stack',
    },
    defaultNamespace: 'monitoring',
    releaseName: 'kube-prometheus-stack',
  },
  {
    id: 'grafana',
    aliases: ['grafana'],
    remote: {
      repoName: 'grafana',
      repoUrl: 'https://grafana.github.io/helm-charts',
      chartRef: 'grafana/grafana',
      releaseName: 'grafana',
    },
    defaultNamespace: 'monitoring',
    releaseName: 'grafana',
  },
  {
    id: 'loki',
    aliases: ['loki'],
    remote: {
      repoName: 'grafana',
      repoUrl: 'https://grafana.github.io/helm-charts',
      chartRef: 'grafana/loki-stack',
      releaseName: 'loki',
    },
    defaultNamespace: 'logging',
    releaseName: 'loki',
  },
  {
    id: 'cert-manager',
    aliases: ['cert-manager', 'certmanager'],
    remote: {
      repoName: 'jetstack',
      repoUrl: 'https://charts.jetstack.io',
      chartRef: 'jetstack/cert-manager',
      releaseName: 'cert-manager',
    },
    defaultNamespace: 'cert-manager',
    releaseName: 'cert-manager',
  },
  {
    id: 'ingress-nginx',
    aliases: ['ingress-nginx', 'nginx-ingress', 'nginxingress'],
    remote: {
      repoName: 'ingress-nginx',
      repoUrl: 'https://kubernetes.github.io/ingress-nginx',
      chartRef: 'ingress-nginx/ingress-nginx',
      releaseName: 'ingress-nginx',
    },
    defaultNamespace: 'ingress-nginx',
    releaseName: 'ingress-nginx',
  },
  {
    id: 'traefik',
    aliases: ['traefik'],
    remote: {
      repoName: 'traefik',
      repoUrl: 'https://traefik.github.io/charts',
      chartRef: 'traefik/traefik',
      releaseName: 'traefik',
    },
    defaultNamespace: 'traefik',
    releaseName: 'traefik',
  },
  {
    id: 'vault',
    aliases: ['vault', 'hashicorp-vault'],
    remote: {
      repoName: 'hashicorp',
      repoUrl: 'https://helm.releases.hashicorp.com',
      chartRef: 'hashicorp/vault',
      releaseName: 'vault',
    },
    defaultNamespace: 'vault',
    releaseName: 'vault',
  },
  {
    id: 'jaeger',
    aliases: ['jaeger'],
    remote: {
      repoName: 'jaegertracing',
      repoUrl: 'https://jaegertracing.github.io/helm-charts',
      chartRef: 'jaegertracing/jaeger',
      releaseName: 'jaeger',
    },
    defaultNamespace: 'observability',
    releaseName: 'jaeger',
  },
];

const ALIAS_INDEX = new Map<string, HelmCatalogEntry>();
for (const entry of ENTRIES) {
  for (const alias of entry.aliases) {
    ALIAS_INDEX.set(alias.toLowerCase().replace(/[^a-z0-9-]/g, ''), entry);
  }
}

export function resolveHelmCatalog(appToken: string): HelmCatalogEntry | undefined {
  const key = appToken.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return ALIAS_INDEX.get(key);
}

export function listHelmCatalogToolNames(): string[] {
  return [...new Set(ENTRIES.map((e) => e.id))].sort();
}
