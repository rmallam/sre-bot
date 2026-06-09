import type { AppGraphNode } from '../types';

export type GraphDisplayKind =
  | 'deployment'
  | 'pod'
  | 'service'
  | 'ingress'
  | 'database'
  | 'cache'
  | 'external';

export function inferDisplayKind(node: AppGraphNode): GraphDisplayKind {
  if (node.kind === 'deployment') return 'deployment';
  if (node.kind === 'pod') return 'pod';
  if (node.kind === 'ingress') return 'ingress';
  const name = node.name.toLowerCase();
  if (/postgres|mysql|mariadb|mongodb|cnpg|timescale/.test(name)) return 'database';
  if (/redis|memcached|valkey/.test(name)) return 'cache';
  if (node.kind === 'external' && node.namespace) {
    if (/postgres|mysql|mariadb|mongodb/.test(name)) return 'database';
    if (/redis|memcached|valkey/.test(name)) return 'cache';
    return 'service';
  }
  if (node.kind === 'service') {
    if (/postgres|mysql|mariadb|mongodb/.test(name)) return 'database';
    if (/redis|memcached|valkey/.test(name)) return 'cache';
    return 'service';
  }
  return 'external';
}

export function displayKindLabel(kind: GraphDisplayKind): string {
  switch (kind) {
    case 'deployment':
      return 'Deployment';
    case 'pod':
      return 'Pod';
    case 'service':
      return 'Service';
    case 'ingress':
      return 'Ingress';
    case 'database':
      return 'Database';
    case 'cache':
      return 'Cache';
    default:
      return 'External';
  }
}

interface IconProps {
  kind: GraphDisplayKind;
  size?: number;
  className?: string;
}

export function AppGraphNodeIcon({ kind, size = 20, className }: IconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
  };

  switch (kind) {
    case 'deployment':
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="5" rx="1" />
          <rect x="4" y="12" width="16" height="5" rx="1" />
          <path d="M8 7.5h8M8 14.5h8" strokeWidth="1.2" />
        </svg>
      );
    case 'pod':
      return (
        <svg {...common}>
          <path d="M12 3l7 4v10l-7 4-7-4V7l7-4z" />
          <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'service':
      return (
        <svg {...common}>
          <circle cx="6" cy="12" r="2.5" />
          <circle cx="18" cy="7" r="2.5" />
          <circle cx="18" cy="17" r="2.5" />
          <path d="M8.5 11l7-3M8.5 13l7 3" />
        </svg>
      );
    case 'ingress':
      return (
        <svg {...common}>
          <path d="M4 8h16v8H4z" />
          <path d="M12 8v8M8 12h8" />
          <path d="M4 12H2M22 12h-2" />
        </svg>
      );
    case 'database':
      return (
        <svg {...common}>
          <ellipse cx="12" cy="6" rx="7" ry="2.5" />
          <path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" />
          <path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
        </svg>
      );
    case 'cache':
      return (
        <svg {...common}>
          <rect x="5" y="5" width="14" height="14" rx="2" />
          <path d="M8 9h8M8 12h8M8 15h5" strokeWidth="1.3" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <path d="M8 12h8" />
        </svg>
      );
  }
}
