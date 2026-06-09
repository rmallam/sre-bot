/**
 * Parse upstream README / install docs for prescribed install commands.
 */

export type ReadmeInstallMethod = 'helm' | 'kubectl' | 'make' | 'script' | 'unknown';

/** Published Helm repo install (helm repo add + helm install repo/chart). */
export interface RemoteHelmInstall {
  repoName: string;
  repoUrl: string;
  /** e.g. frappe-operator/frappe-operator */
  chartRef: string;
  releaseName?: string;
}

export interface ReadmeInstallHints {
  method: ReadmeInstallMethod;
  chartPath?: string;
  manifestPath?: string;
  scriptPath?: string;
  evidence?: string;
  /** True when README uses helm repo/chart (not a path in the cloned Git tree). */
  remoteHelmRepo?: boolean;
  /** Parsed remote Helm repo coordinates when README documents helm repo add + install. */
  remoteHelm?: RemoteHelmInstall;
}

const HELM_INSTALL =
  /helm\s+(?:upgrade\s+--install|install)\s+([\w.-]+)\s+([\w.-]+\/[\w.-]+)/i;
const HELM_INSTALL_LOCAL =
  /helm\s+(?:upgrade\s+--install|install)\s+[\w.-]+\s+(\.\/?(?:helm|charts|deploy)\/[\w.-]+)/i;
const HELM_REPO_ADD_LINE =
  /helm\s+repo\s+add\s+([\w.-]+)\s+(https?:\/\/[^\s'"]+)/i;
const HELM_CHART_PATH = /(?:^|[\s/`])((?:\.\/)?(?:helm|charts|deploy)\/[\w.-]+\/Chart\.yaml)/im;
const KUBECTL_APPLY = /kubectl\s+apply\s+(?:-[fk]\s+)?([^\s]+\.ya?ml)/i;
const INSTALL_YAML = /\binstall\.ya?ml\b/i;
const MAKE_INSTALL = /make\s+(?:install|deploy)\b/i;
const INSTALL_SH = /\.\/install\.sh\b|bash\s+install\.sh\b/i;

/** Paths that exist under a cloned repo (not `helm repo add` chart refs like `foo/bar`). */
export function isLocalHelmChartPath(path: string | undefined): boolean {
  if (!path?.trim()) return false;
  const p = path.replace(/^\.\//, '').replace(/\/Chart\.yaml$/i, '');
  if (/^(helm|charts|deploy|config)\//i.test(p)) return true;
  if (p.startsWith('../')) return true;
  // Remote chart ref: release/chart with no repo directory prefix (e.g. frappe-operator/frappe-operator)
  if (/^[\w.-]+\/[\w.-]+$/.test(p) && !/^(helm|charts|deploy)\//i.test(p)) return false;
  return p.includes('/') && !/^https?:\/\//i.test(p);
}

function parseRemoteHelmInstall(text: string): RemoteHelmInstall | undefined {
  const installMatch = text.match(HELM_INSTALL);
  if (!installMatch) return undefined;
  const releaseName = installMatch[1];
  const chartRef = installMatch[2]!.replace(/\\$/, '').trim();
  if (isLocalHelmChartPath(chartRef)) return undefined;

  let repoName: string | undefined;
  let repoUrl: string | undefined;
  for (const line of text.split('\n')) {
    const add = line.match(HELM_REPO_ADD_LINE);
    if (add) {
      repoName = add[1];
      repoUrl = add[2];
    }
  }
  if (!repoName || !repoUrl) return undefined;
  if (!chartRef.startsWith(`${repoName}/`)) return undefined;

  return { repoName, repoUrl, chartRef, releaseName };
}

export function parseReadmeInstallHints(readme: string): ReadmeInstallHints | null {
  const text = readme.slice(0, 80_000);
  if (!text.trim()) return null;

  const chartFromPath = text.match(HELM_CHART_PATH)?.[1];
  if (chartFromPath) {
    const chartPath = chartFromPath.replace(/^\.\//, '').replace(/\/Chart\.yaml$/i, '');
    return {
      method: 'helm',
      chartPath,
      evidence: chartFromPath,
      remoteHelmRepo: false,
    };
  }

  const localInstall = text.match(HELM_INSTALL_LOCAL);
  if (localInstall) {
    const chartPath = localInstall[1]!.replace(/^\.\//, '');
    return {
      method: 'helm',
      chartPath,
      evidence: localInstall[0],
      remoteHelmRepo: false,
    };
  }

  const remoteHelm = parseRemoteHelmInstall(text);
  if (remoteHelm) {
    return {
      method: 'helm',
      evidence: `helm install ${remoteHelm.releaseName ?? 'release'} ${remoteHelm.chartRef}`,
      remoteHelmRepo: true,
      remoteHelm,
    };
  }

  const helmMatch = text.match(HELM_INSTALL);
  if (helmMatch) {
    const raw = helmMatch[2]!.replace(/^\.\//, '').replace(/\/Chart\.yaml$/i, '').replace(/\\$/, '').trim();
    const remoteHelmRepo = !isLocalHelmChartPath(raw);
    if (isLocalHelmChartPath(raw)) {
      return {
        method: 'helm',
        chartPath: raw,
        evidence: helmMatch[0],
        remoteHelmRepo: false,
      };
    }
    if (remoteHelmRepo) {
      return {
        method: 'helm',
        evidence: helmMatch[0],
        remoteHelmRepo: true,
      };
    }
  }

  const kubectlMatch = text.match(KUBECTL_APPLY);
  if (kubectlMatch) {
    const manifestPath = kubectlMatch[1]?.replace(/^["']|["']$/g, '');
    if (manifestPath && !/^https?:\/\//i.test(manifestPath)) {
      return {
        method: 'kubectl',
        manifestPath,
        evidence: kubectlMatch[0],
      };
    }
  }

  if (INSTALL_YAML.test(text)) {
    return {
      method: 'kubectl',
      manifestPath: 'install.yaml',
      evidence: 'install.yaml mentioned in README',
    };
  }

  if (INSTALL_SH.test(text)) {
    return { method: 'script', scriptPath: 'install.sh', evidence: 'install.sh' };
  }

  if (MAKE_INSTALL.test(text)) {
    return { method: 'make', scriptPath: 'Makefile', evidence: text.match(MAKE_INSTALL)?.[0] };
  }

  return null;
}

/**
 * Prefer repo-detected manifest when README points at a remote Helm repo or invalid local path.
 */
export function resolveDeployManifestPath(opts: {
  detectedManifestPath?: string;
  readmeHints?: ReadmeInstallHints | null;
}): { manifestPath?: string; source: 'detected' | 'readme' | 'none'; note?: string } {
  const detected = opts.detectedManifestPath;
  const readme = opts.readmeHints;

  if (readme?.method === 'helm' && readme.chartPath && isLocalHelmChartPath(readme.chartPath)) {
    return { manifestPath: `${readme.chartPath}/Chart.yaml`, source: 'readme' };
  }

  if (readme?.method === 'helm' && readme.remoteHelmRepo && detected && !readme.remoteHelm) {
    return {
      manifestPath: detected,
      source: 'detected',
      note: 'README uses remote Helm repo — using chart found in cloned repository.',
    };
  }

  if (detected) {
    return { manifestPath: detected, source: 'detected' };
  }

  if (readme?.method === 'kubectl' && readme.manifestPath) {
    return { manifestPath: readme.manifestPath, source: 'readme' };
  }

  return { source: 'none' };
}
