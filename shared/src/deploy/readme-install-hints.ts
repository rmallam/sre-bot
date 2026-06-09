/**
 * Parse upstream README / install docs for prescribed install commands.
 */

export type ReadmeInstallMethod = 'helm' | 'kubectl' | 'make' | 'script' | 'unknown';

export interface ReadmeInstallHints {
  method: ReadmeInstallMethod;
  chartPath?: string;
  manifestPath?: string;
  scriptPath?: string;
  evidence?: string;
  /** True when README uses helm repo/chart (not a path in the cloned Git tree). */
  remoteHelmRepo?: boolean;
}

const HELM_INSTALL =
  /helm\s+(?:upgrade\s+--install|install)\s+\S+\s+([^\s\\]+)/i;
const HELM_CHART_PATH = /(?:^|[\s/`])((?:\.\/)?(?:helm|charts|deploy)\/[\w.-]+\/Chart\.yaml)/im;
const KUBECTL_APPLY = /kubectl\s+apply\s+(?:-[fk]\s+)?([^\s]+\.ya?ml)/i;
const INSTALL_YAML = /\binstall\.ya?ml\b/i;
const MAKE_INSTALL = /make\s+(?:install|deploy)\b/i;
const INSTALL_SH = /\.\/install\.sh\b|bash\s+install\.sh\b/i;
const HELM_REPO_ADD = /helm\s+repo\s+add\b/i;

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

  const helmMatch = text.match(HELM_INSTALL);
  if (helmMatch) {
    const raw = helmMatch[1]!.replace(/^\.\//, '').replace(/\/Chart\.yaml$/i, '').replace(/\\$/, '').trim();
    const remoteHelmRepo = HELM_REPO_ADD.test(text) && !isLocalHelmChartPath(raw);
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

  if (readme?.method === 'helm' && readme.remoteHelmRepo && detected) {
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
