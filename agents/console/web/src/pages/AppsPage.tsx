import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchAppCatalog, fetchAppReview, fetchApps, saveAppCatalogEntry } from '../api';
import type { AppCatalogEntry, AppListEntry, AppReviewResult } from '../types';
import { AppGraphPanel } from '../components/AppGraphPanel';

interface Props {
  live: boolean;
}

export function AppsPage({ live }: Props) {
  const [searchParams] = useSearchParams();
  const urlApp = searchParams.get('app');
  const urlNs = searchParams.get('ns');

  const [appId, setAppId] = useState(urlApp ?? '');
  const [appNamespace, setAppNamespace] = useState(urlNs ?? '');
  const [appReview, setAppReview] = useState<AppReviewResult | null>(null);
  const [appError, setAppError] = useState<string | null>(null);
  const [appLoading, setAppLoading] = useState(false);
  const [allApps, setAllApps] = useState<AppListEntry[]>([]);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [appsLoading, setAppsLoading] = useState(true);
  const [catalogEntry, setCatalogEntry] = useState<AppCatalogEntry | null>(null);

  const appsInNamespace = useMemo(
    () => allApps.filter((a) => a.namespace === appNamespace),
    [allApps, appNamespace]
  );

  const loadApps = useCallback(() => {
    setAppsLoading(true);
    return fetchApps()
      .then((data) => {
        setAllApps(data.apps);
        const nsList = data.namespaces?.length
          ? data.namespaces
          : [...new Set(data.apps.map((a) => a.namespace))].sort();
        setNamespaces(nsList);

        if (!urlNs && !urlApp && nsList.length > 0) {
          setAppNamespace((prev) => {
            if (prev && nsList.includes(prev)) return prev;
            return nsList[0]!;
          });
        }
        return { ...data, namespaces: nsList };
      })
      .catch((err) => {
        console.error(err);
        return null;
      })
      .finally(() => setAppsLoading(false));
  }, [urlApp, urlNs]);

  useEffect(() => {
    if (!urlNs && !urlApp && namespaces.length > 0 && appNamespace) {
      const appsInNs = allApps.filter((a) => a.namespace === appNamespace);
      if (appsInNs.length > 0) {
        setAppId((prev) => (prev && appsInNs.some((a) => a.appId === prev) ? prev : appsInNs[0]!.appId));
      }
    }
  }, [allApps, appNamespace, namespaces, urlApp, urlNs]);

  const loadCatalogForSelection = useCallback((ns: string, id: string) => {
    if (!ns || !id) {
      setCatalogEntry(null);
      return;
    }
    fetchAppCatalog()
      .then(({ entries }) => {
        const found = entries.find(
          (e) => e.namespace === ns && e.appId.toLowerCase() === id.toLowerCase()
        );
        setCatalogEntry(found ?? null);
      })
      .catch(console.error);
  }, []);

  const loadAppReview = useCallback(
    (force = false) => {
      if (!appId.trim() || !appNamespace.trim()) return;
      setAppLoading(true);
      fetchAppReview(appId.trim(), appNamespace.trim(), force)
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
    void loadApps();
  }, [loadApps]);

  useEffect(() => {
    if (!appId.trim() || !appNamespace.trim()) return;
    loadAppReview(true);
    loadCatalogForSelection(appNamespace, appId);
    const ms = live ? 30000 : 120000;
    const id = setInterval(() => loadAppReview(true), ms);
    return () => clearInterval(id);
  }, [live, loadAppReview, loadCatalogForSelection, appId, appNamespace]);

  const handleNamespaceChange = (ns: string) => {
    setAppNamespace(ns);
    const nextApps = allApps.filter((a) => a.namespace === ns);
    const stillValid = nextApps.some((a) => a.appId === appId);
    if (!stillValid && nextApps[0]) {
      setAppId(nextApps[0].appId);
    }
  };

  const handleSaveCatalog = async (entry: AppCatalogEntry) => {
    const saved = await saveAppCatalogEntry(entry);
    setCatalogEntry(saved);
    await loadApps();
    loadAppReview(true);
  };

  return (
    <>
      <p style={{ fontSize: '0.8125rem', color: 'var(--text-dim)', margin: '0 0 1rem' }}>
        Dependency graph and health review per application. Apps are auto-discovered from Helm releases
        and deploy metadata; edit the catalog below to curate members and dependencies.
      </p>
      <AppGraphPanel
        review={appReview}
        loading={appLoading}
        error={appError}
        appId={appId}
        namespace={appNamespace}
        apps={appsInNamespace}
        allApps={allApps}
        namespaces={namespaces}
        appsLoading={appsLoading}
        catalogEntry={catalogEntry}
        onAppIdChange={setAppId}
        onNamespaceChange={handleNamespaceChange}
        onSelectApp={(a) => {
          setAppId(a.appId);
          setAppNamespace(a.namespace);
        }}
        onRefresh={() => {
          loadApps();
          loadAppReview(true);
          loadCatalogForSelection(appNamespace, appId);
        }}
        onSaveCatalog={handleSaveCatalog}
      />
    </>
  );
}
