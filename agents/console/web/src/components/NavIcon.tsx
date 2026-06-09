interface Props {
  name: 'overview' | 'approvals' | 'runs' | 'apps' | 'activity' | 'assistant' | 'ignored';
}

export function NavIcon({ name }: Props) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.35,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  switch (name) {
    case 'overview':
      return (
        <svg {...common}>
          <rect x="2" y="2" width="5" height="5" rx="1" />
          <rect x="9" y="2" width="5" height="5" rx="1" />
          <rect x="2" y="9" width="5" height="5" rx="1" />
          <rect x="9" y="9" width="5" height="5" rx="1" />
        </svg>
      );
    case 'approvals':
      return (
        <svg {...common}>
          <path d="M8 2.5l1.4 2.8 3.1.5-2.2 2.2.5 3.1L8 9.8 5.2 11.1l.5-3.1-2.2-2.2 3.1-.5L8 2.5z" />
        </svg>
      );
    case 'runs':
      return (
        <svg {...common}>
          <path d="M4 3.5h8v2H4zM4 7.5h8v2H4zM4 11.5h5v2H4z" />
          <circle cx="12.5" cy="12.5" r="2.5" />
        </svg>
      );
    case 'apps':
      return (
        <svg {...common}>
          <circle cx="8" cy="4" r="2" />
          <circle cx="4" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <path d="M8 6v2M6.5 10.5L7.5 9M9.5 9l1 1.5" />
        </svg>
      );
    case 'activity':
      return (
        <svg {...common}>
          <path d="M4 6h16M4 12h10M4 18h14" />
          <circle cx="18" cy="12" r="2" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'assistant':
      return (
        <svg {...common}>
          <path d="M3 4.5h10v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7z" />
          <path d="M5.5 8h5M5.5 10h3" />
          <path d="M6 4.5V3a2 2 0 0 1 4 0v1.5" />
        </svg>
      );
    case 'ignored':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M4.5 4.5l7 7" />
        </svg>
      );
  }
}
