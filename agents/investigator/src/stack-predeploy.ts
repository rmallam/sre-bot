import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { shallowCloneRepo } from './git-clone.js';
import type {
  DeployRequest,
  RepoSignals,
  StackDependencyEdge,
  StackDeployAnalysis,
  StackServiceAnalysis,
  StackServiceRef,
} from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'investigator';
const MAX_SCAN_FILES = 220;
const MAX_SCAN_BYTES = 256 * 1024;

type EntryPointKind = StackServiceAnalysis['entryPointKind'];

function detectRepoSignals(repoDir: string): RepoSignals {
  return {
    hasDockerfile: existsSync(join(repoDir, 'Dockerfile')),
    hasPackageJson: existsSync(join(repoDir, 'package.json')),
    hasGoMod: existsSync(join(repoDir, 'go.mod')),
    primaryLanguage: existsSync(join(repoDir, 'package.json'))
      ? 'nodejs'
      : existsSync(join(repoDir, 'go.mod'))
        ? 'go'
        : 'unknown',
  };
}

async function detectEntryPoint(repoDir: string): Promise<{
  entryPointKind: EntryPointKind;
  manifestPath?: string;
  needsHelmGeneration: boolean;
}> {
  const kustomizeCandidates = [
    'kustomization.yaml',
    'kustomization.yml',
    'base/kustomization.yaml',
    'base/kustomization.yml',
    'k8s/kustomization.yaml',
    'overlays/prod/kustomization.yaml',
  ];
  for (const rel of kustomizeCandidates) {
    const p = join(repoDir, rel);
    if (existsSync(p)) {
      return { entryPointKind: 'kustomize', manifestPath: rel, needsHelmGeneration: false };
    }
  }

  const helmCandidates = ['Chart.yaml', 'helm/Chart.yaml', 'charts/Chart.yaml'];
  for (const rel of helmCandidates) {
    const p = join(repoDir, rel);
    if (existsSync(p)) {
      return { entryPointKind: 'helm', manifestPath: rel, needsHelmGeneration: false };
    }
  }

  const yamlDirs = ['', 'deploy', 'k8s', 'manifests', 'kubernetes'];
  for (const dirRel of yamlDirs) {
    const dir = join(repoDir, dirRel);
    if (!existsSync(dir)) continue;
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    const firstYaml = entries.find((e) => ['.yaml', '.yml'].includes(extname(e).toLowerCase()));
    if (firstYaml) {
      const manifestPath = dirRel ? `${dirRel}/${firstYaml}` : firstYaml;
      return { entryPointKind: 'plain-yaml', manifestPath, needsHelmGeneration: false };
    }
  }

  return { entryPointKind: 'unknown', needsHelmGeneration: true };
}

async function listTextFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue: string[] = [root];
  while (queue.length > 0 && files.length < MAX_SCAN_FILES) {
    const dir = queue.shift()!;
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.git') || entry.name === 'node_modules' || entry.name === 'vendor') {
        continue;
      }
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(abs);
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (
        ['.ts', '.tsx', '.js', '.jsx', '.go', '.py', '.java', '.kt', '.yaml', '.yml', '.json', '.env', '.properties', '.conf', '.toml', '.ini', '.md'].includes(
          ext
        ) || !ext
      ) {
        files.push(abs);
      }
      if (files.length >= MAX_SCAN_FILES) break;
    }
  }
  return files;
}

async function inferDependenciesFromRepo(repoDir: string, serviceNames: string[]): Promise<string[]> {
  const files = await listTextFiles(repoDir);
  const deps = new Set<string>();
  for (const file of files) {
    try {
      const content = await readFile(file, 'utf-8');
      if (content.length > MAX_SCAN_BYTES) continue;
      const lower = content.toLowerCase();
      for (const svc of serviceNames) {
        const s = svc.toLowerCase();
        if (
          lower.includes(`http://${s}`) ||
          lower.includes(`https://${s}`) ||
          lower.includes(`grpc://${s}`) ||
          lower.includes(`${s}.svc`) ||
          lower.includes(`${s}_service`) ||
          lower.includes(`${s}_url`) ||
          lower.includes(`${s}_host`) ||
          lower.includes(`service: ${s}`)
        ) {
          deps.add(svc);
        }
      }
    } catch {
      continue;
    }
  }
  return [...deps];
}

function topoSort(services: string[], edges: StackDependencyEdge[]): { order: string[]; hasCycle: boolean } {
  const deps = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  for (const s of services) {
    deps.set(s, new Set());
    reverse.set(s, new Set());
  }
  for (const e of edges) {
    deps.get(e.to)?.add(e.from);
    reverse.get(e.from)?.add(e.to);
  }

  const queue: string[] = services.filter((s) => (deps.get(s)?.size ?? 0) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    order.push(n);
    for (const child of reverse.get(n) ?? []) {
      const childDeps = deps.get(child);
      if (!childDeps) continue;
      childDeps.delete(n);
      if (childDeps.size === 0) queue.push(child);
    }
  }
  if (order.length === services.length) return { order, hasCycle: false };
  return { order: services, hasCycle: true };
}

async function analyzeService(
  svc: StackServiceRef,
  allServiceNames: string[],
  incidentId: string
): Promise<StackServiceAnalysis> {
  const tmpDir = await mkdtemp(join(tmpdir(), `sre-stack-${incidentId}-`));
  try {
    const clone = await shallowCloneRepo(svc.githubRepo, svc.gitRef ?? 'main', tmpDir, incidentId);
    if (!clone.ok) {
      return {
        ...svc,
        entryPointKind: 'unknown',
        needsHelmGeneration: true,
        cloneError: clone.error,
        dependencies: [],
      };
    }

    const entry = await detectEntryPoint(tmpDir);
    const repoSignals = detectRepoSignals(tmpDir);
    const dependencies = (await inferDependenciesFromRepo(tmpDir, allServiceNames)).filter(
      (name) => name !== svc.name
    );
    return {
      ...svc,
      resolvedGitRef: clone.resolvedRef ?? svc.gitRef ?? 'main',
      entryPointKind: entry.entryPointKind,
      manifestPath: entry.manifestPath,
      needsHelmGeneration: entry.needsHelmGeneration,
      repoSignals,
      dependencies,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function gatherStackPreDeployFacts(req: DeployRequest): Promise<StackDeployAnalysis> {
  const stackServices = req.stackServices ?? [];
  if (stackServices.length < 2) {
    throw new Error('stack-facts requires at least two services');
  }

  const serviceNames = stackServices.map((s) => s.name);
  const services = await Promise.all(
    stackServices.map((svc) => analyzeService(svc, serviceNames, req.incidentId))
  );

  const dependencyEdges: StackDependencyEdge[] = [];
  for (const svc of services) {
    for (const dep of svc.dependencies) {
      dependencyEdges.push({
        from: dep,
        to: svc.name,
        reason: `${svc.name} references ${dep} endpoints/config`,
      });
    }
  }

  const sorted = topoSort(serviceNames, dependencyEdges);
  const analysis: StackDeployAnalysis = {
    stackName: req.resourceName,
    namespace: req.namespace,
    services,
    dependencyEdges,
    deploymentOrder: sorted.order,
    hasCycle: sorted.hasCycle,
  };

  log('info', AGENT, 'Stack pre-deploy analysis complete', {
    incidentId: req.incidentId,
    serviceCount: services.length,
    edges: dependencyEdges.length,
    hasCycle: sorted.hasCycle,
    order: sorted.order.join(' -> '),
  });
  return analysis;
}
