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
}

const HELM_INSTALL =
  /helm\s+(?:upgrade\s+--install|install)\s+\S+\s+([^\s]+(?:\/[^\s]+)?)/i;
const HELM_CHART_PATH = /helm\/[\w.-]+\/Chart\.yaml/i;
const KUBECTL_APPLY = /kubectl\s+apply\s+(?:-[fk]\s+)?([^\s]+\.ya?ml)/i;
const INSTALL_YAML = /\binstall\.ya?ml\b/i;
const MAKE_INSTALL = /make\s+(?:install|deploy)\b/i;
const INSTALL_SH = /\.\/install\.sh\b|bash\s+install\.sh\b/i;

export function parseReadmeInstallHints(readme: string): ReadmeInstallHints | null {
  const text = readme.slice(0, 80_000);
  if (!text.trim()) return null;

  const helmMatch = text.match(HELM_INSTALL);
  if (helmMatch || HELM_CHART_PATH.test(text)) {
    const chartFromPath = text.match(HELM_CHART_PATH)?.[0];
    const chartFromCmd = helmMatch?.[1]?.replace(/^\.\//, '').replace(/\/Chart\.yaml$/i, '');
    const chartPath = chartFromPath?.replace(/\/Chart\.yaml$/i, '') ?? chartFromCmd;
    return {
      method: 'helm',
      chartPath: chartPath?.includes('/') ? chartPath : undefined,
      evidence: helmMatch?.[0] ?? chartFromPath,
    };
  }

  const kubectlMatch = text.match(KUBECTL_APPLY);
  if (kubectlMatch) {
    return {
      method: 'kubectl',
      manifestPath: kubectlMatch[1]?.replace(/^["']|["']$/g, ''),
      evidence: kubectlMatch[0],
    };
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
