import { useCallback, useEffect, useMemo, useState } from 'react';
import { exportSkillsMarkdown, fetchRunsGrouped } from '../api';
import type { ResourceRunGroup } from '../types';
import { ResourceGroupCard } from '../components/ResourceGroupCard';
import { useToast } from '../components/Toast';

interface Props {
  live: boolean;
}

export function RunsPage({ live }: Props) {
  const toast = useToast();
  const [groups, setGroups] = useState<ResourceRunGroup[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(() => {
    fetchRunsGrouped(150).then((d) => setGroups(d.groups)).catch(console.error);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, live ? 5000 : 30000);
    return () => clearInterval(id);
  }, [live, load]);

  const filtered = useMemo(() => {
    return groups
      .filter((g) => {
        if (statusFilter && g.latestStatus !== statusFilter) return false;
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        return (
          g.displayName.toLowerCase().includes(q) ||
          (g.namespace?.toLowerCase().includes(q) ?? false) ||
          (g.resourceName?.toLowerCase().includes(q) ?? false) ||
          (g.githubRepo?.toLowerCase().includes(q) ?? false) ||
          g.runs.some(
            (r) =>
              r.outcome?.rootCause?.toLowerCase().includes(q) ||
              r.outcome?.suggestedAction?.toLowerCase().includes(q)
          )
        );
      })
      .map((g) =>
        showHistory
          ? g
          : { ...g, runs: g.runs.slice(0, 1), attemptCount: g.runs.length > 0 ? g.attemptCount : 0 }
      );
  }, [groups, search, statusFilter, showHistory]);

  async function copySkill(md: string) {
    try {
      await navigator.clipboard.writeText(md);
      toast('Skill snippet copied');
    } catch {
      toast('Could not copy to clipboard', true);
    }
  }

  async function exportAllSkills() {
    try {
      const { markdown, count } = await exportSkillsMarkdown(150);
      await navigator.clipboard.writeText(markdown);
      toast(`Exported ${count} skill snippets to clipboard`);
    } catch (e) {
      toast(String(e), true);
    }
  }

  return (
    <>
      <div className="filter-bar">
        <input
          placeholder="Search runs, root causes, fixes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 240 }}
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="running">Running</option>
          <option value="awaiting_human">Awaiting human</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="escalated">Escalated</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={showHistory}
            onChange={(e) => setShowHistory(e.target.checked)}
          />
          Show full attempt history
        </label>
        <button type="button" className="btn btn-sm" onClick={load}>
          Refresh
        </button>
        <button type="button" className="btn btn-sm" onClick={exportAllSkills}>
          Export skills
        </button>
      </div>

      <p style={{ fontSize: '0.8125rem', color: 'var(--text-dim)', margin: '0 0 1rem' }}>
        Investigation and remediation attempts, grouped by workload. Click a run ID for the full
        timeline and tool steps.
      </p>

      {filtered.length === 0 && (
        <div className="empty-state">
          <h3>No runs match</h3>
          <p>Try clearing filters or start an investigation from the Assistant.</p>
        </div>
      )}

      {filtered.map((g) => (
        <ResourceGroupCard key={g.resourceKey} group={g} onCopySkill={copySkill} />
      ))}
    </>
  );
}
