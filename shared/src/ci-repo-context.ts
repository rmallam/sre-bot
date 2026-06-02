/**
 * Types for CI repo context gathered before brain code-fix planning.
 */

export interface CiRepoFileSnippet {
  path: string;
  /** Truncated file content for LLM context. */
  excerpt: string;
}

export interface CiRepoContext {
  githubRepo: string;
  branch: string;
  files: CiRepoFileSnippet[];
  /** Paths checked but missing on branch. */
  missingPaths: string[];
  workflowFilePath?: string;
}

/** Default paths to inspect for dependency / build failures. */
export const CI_REPO_CONTEXT_PATHS = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'requirements.txt',
  'pyproject.toml',
  'Pipfile',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'Dockerfile',
  'docker-compose.yml',
] as const;
