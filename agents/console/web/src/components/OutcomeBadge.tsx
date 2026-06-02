interface Props {
  worked: boolean | null | undefined;
}

export function OutcomeBadge({ worked }: Props) {
  if (worked === true) {
    return <span className="outcome-badge worked">Worked</span>;
  }
  if (worked === false) {
    return <span className="outcome-badge failed">Did not work</span>;
  }
  return <span className="outcome-badge pending">Pending</span>;
}

export function formatAction(action: string): string {
  return action.replace(/_/g, ' ');
}
