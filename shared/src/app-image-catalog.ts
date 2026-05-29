/**
 * Well-known container images for "deploy httpd" style commands (no Git repo).
 */

const CATALOG: Record<string, string> = {
  httpd: 'httpd:2.4-alpine',
  apache: 'httpd:2.4-alpine',
  https: 'httpd:2.4-alpine',
  nginx: 'nginx:stable-alpine',
  redis: 'redis:7-alpine',
  postgres: 'postgres:16-alpine',
  postgresql: 'postgres:16-alpine',
  mysql: 'mysql:8',
  mariadb: 'mariadb:11',
  busybox: 'busybox:latest',
};

export function resolveCatalogImage(appToken: string): string | undefined {
  const key = appToken.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return CATALOG[key];
}

export function listCatalogAppNames(): string[] {
  return [...new Set(Object.keys(CATALOG))].sort();
}
