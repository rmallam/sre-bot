/** Normalize github.com/org/repo or URL to owner/repo slug. */
export function normalizeGithubSlug(repo: string): string {
  let slug = repo.trim().replace(/^https?:\/\//, '').replace(/\.git$/i, '');
  slug = slug.replace(/^github\.com\//i, '');
  const parts = slug.split('/').filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return slug;
}

export function parseOwnerRepo(slug: string): { owner: string; repo: string } {
  const n = normalizeGithubSlug(slug);
  const [owner, repo] = n.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid GitHub repo slug: ${slug}`);
  }
  return { owner, repo };
}
