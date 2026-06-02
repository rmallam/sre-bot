import { useCallback, useEffect, useState } from 'react';
import { fetchIgnored, unignoreResource } from '../api';
import type { IgnoredResource } from '../types';
import { useToast } from '../components/Toast';

interface Props {
  live: boolean;
}

export function IgnoredPage({ live }: Props) {
  const toast = useToast();
  const [resources, setResources] = useState<IgnoredResource[]>([]);

  const load = useCallback(() => {
    fetchIgnored().then((d) => setResources(d.resources ?? []));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, live ? 10000 : 60000);
    return () => clearInterval(id);
  }, [live, load]);

  async function handleUnignore(key: string) {
    try {
      await unignoreResource(key);
      toast(`Unignored ${key}`);
      load();
    } catch (e) {
      toast(String(e), true);
    }
  }

  return (
    <>
      <p style={{ color: 'var(--text-muted)', marginTop: 0, maxWidth: 560 }}>
        Ignored resources will not trigger new remediation or HIL approvals from the watcher.
        Manual commands from Telegram still work.
      </p>

      <div className="card">
        {resources.length === 0 ? (
          <div className="empty-state">
            <h3>Nothing ignored</h3>
            <p>Use Ignore on an approval card (here or in Telegram) to suppress a noisy workload.</p>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Ignored by</th>
                <th>Since</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {resources.map((r) => (
                <tr key={r.key}>
                  <td className="mono">{r.key}</td>
                  <td>{r.ignoredBy}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                    {new Date(r.ignoredAt).toLocaleString()}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => handleUnignore(r.key)}
                    >
                      Unignore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
