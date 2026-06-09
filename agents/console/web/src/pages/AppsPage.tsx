import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchAppReview, fetchApps } from '../api';
import type { AppListEntry, AppReviewResult } from '../types';
import { AppGraphPanel } from '../components/AppGraphPanel';

interface Props {
  live: boolean;
}

export function AppsPage({ live }: Props) {
  const [searchParams] = useSearchParams();
  const [appId, setAppId] = useState(() => searchParams.get('app') ?? 'commander-agent');
  const [appNamespace, setAppNamespace] = useState(() => searchParams.get('ns') ?? 'sre-bot-system');
  const [appReview, setAppReview] = useState<AppReviewResult | null>(null);
  const [appError, setAppError] = useState<string | null>(null);
  const [appLoading, setAppLoading] = useState(false);
  const [apps, setApps] = useState<AppListEntry[]>([]);
  const [appsLoading, setAppsLoading] = useState(true);

  const loadApps = useCallback((ns?: string) => {
    setAppsLoading(true);
    fetchApps(ns)
      .then((data) => setApps(data.apps))
      .catch(console.error)
      .finally(() => setAppsLoading(false));
  }, []);

  const loadAppReview = useCallback(
    (force = false) => {
      if (!appId.trim()) return;
      setAppLoading(true);
      fetchAppReview(appId.trim(), appNamespace.trim() || undefined, force)
        .then((data) => {
          setAppReview(data);
          setAppError(null);
        })
        .catch((err) => {
          setAppError(String(err));
        })
        .finally(() => setAppLoading(false));
    },
    [appId, appNamespace]
  );

  useEffect(() => {
    loadApps(appNamespace.trim() || undefined);
    loadAppReview(true);
    const ms = live ? 30000 : 120000;
    const id = setInterval(() => loadAppReview(true), ms);
    return () => clearInterval(id);
  }, [live, loadApps, loadAppReview, appNamespace]);

  return (
    <>
      <p style={{ fontSize: '0.8125rem', color: 'var(--text-dim)', margin: '0 0 1rem' }}>
        Dependency graph and health review per application. Pick an app to see components, status, and
        the failure frontier.
      </p>
      <AppGraphPanel
        review={appReview}
        loading={appLoading}
        error={appError}
        appId={appId}
        namespace={appNamespace}
        apps={apps}
        appsLoading={appsLoading}
        onAppIdChange={setAppId}
        onNamespaceChange={(ns) => {
          setAppNamespace(ns);
          loadApps(ns.trim() || undefined);
        }}
        onSelectApp={(a) => {
          setAppId(a.appId);
          setAppNamespace(a.namespace);
          setAppLoading(true);
          fetchAppReview(a.appId, a.namespace, true)
            .then((data) => {
              setAppReview(data);
              setAppError(null);
            })
            .catch((err) => setAppError(String(err)))
            .finally(() => setAppLoading(false));
        }}
        onRefresh={() => {
          loadApps(appNamespace.trim() || undefined);
          loadAppReview(true);
        }}
      />
    </>
  );
}
