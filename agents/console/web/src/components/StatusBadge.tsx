interface Props {
  status: string;
}

export function StatusBadge({ status }: Props) {
  const normalized = status.toLowerCase().replace(/\s/g, '_');
  const cls = `badge badge-${normalized}`;
  const label = status.replace(/_/g, ' ');
  return <span className={cls}>{label}</span>;
}
