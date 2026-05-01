/**
 * GitHub Project Discovery — #447
 *
 * Discovers (or creates) the GitHub Projects v2 project for a given git repository.
 *
 * Flow:
 *   1. Read `git remote get-url origin` → parse owner/repo (handles https:// and git@ forms)
 *   2. `gh project list --owner <owner> --format json` → find a candidate whose title
 *      contains the repo name (case-insensitive)
 *   3. If nothing matches → create a new project titled `<repo> AI Project`
 *   4. Return { owner, repo, projectNumber, projectId, projectTitle }
 *
 * The settings-store mapping is the persistent cache — this module only runs discovery
 * when a mapping is not yet stored for the given projectPath.
 */

import { execFileNoThrow } from '../utils/execFile';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GithubProjectMapping {
	owner: string;
	repo: string;
	projectNumber: number;
	projectId: string;
	projectTitle: string;
	discoveredAt: string;
}

// ---------------------------------------------------------------------------
// discoverGithubProject
// ---------------------------------------------------------------------------

/**
 * Discover the GitHub Projects v2 project for the git repo rooted at `projectPath`.
 *
 * Does NOT persist the result — callers (IPC handler) are responsible for saving
 * the mapping to the settings store.
 */
export async function discoverGithubProject(projectPath: string): Promise<GithubProjectMapping> {
	// 1. Resolve owner + repo from git remote
	const { owner, repo } = await parseGitRemote(projectPath);

	// 2. List existing projects for this owner
	const projects = await listOwnerProjects(owner);

	// 3. Find best candidate (title contains repo name, case-insensitive)
	const repoLower = repo.toLowerCase();
	const candidate = projects.find(
		(p) => typeof p.title === 'string' && p.title.toLowerCase().includes(repoLower)
	);

	if (candidate) {
		return {
			owner,
			repo,
			projectNumber: candidate.number,
			projectId: candidate.id,
			projectTitle: candidate.title,
			discoveredAt: new Date().toISOString(),
		};
	}

	// 4. No matching project — create one
	const newProject = await createProject(owner, `${repo} AI Project`);
	return {
		owner,
		repo,
		projectNumber: newProject.number,
		projectId: newProject.id,
		projectTitle: newProject.title,
		discoveredAt: new Date().toISOString(),
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RemoteCoords {
	owner: string;
	repo: string;
}

/**
 * Parse owner and repo from `git remote get-url origin`.
 *
 * Handles both:
 *   - https://github.com/owner/repo.git
 *   - git@github.com:owner/repo.git
 */
async function parseGitRemote(cwd: string): Promise<RemoteCoords> {
	const result = await execFileNoThrow('git', ['remote', 'get-url', 'origin'], cwd);
	if (result.exitCode !== 0 || !result.stdout.trim()) {
		throw new Error(
			`Could not read git remote origin for "${cwd}": ${result.stderr.trim() || 'no output'}`
		);
	}

	const url = result.stdout.trim();

	// git@github.com:owner/repo.git  or  git@github.com:owner/repo
	const sshMatch = /git@[^:]+:([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
	if (sshMatch) {
		return { owner: sshMatch[1], repo: sshMatch[2] };
	}

	// https://github.com/owner/repo.git  or  https://github.com/owner/repo
	const httpsMatch = /https?:\/\/[^/]+\/([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
	if (httpsMatch) {
		return { owner: httpsMatch[1], repo: httpsMatch[2] };
	}

	throw new Error(`Unrecognised git remote URL format: "${url}"`);
}

interface RawProject {
	id: string;
	number: number;
	title: string;
}

/**
 * Return all Projects v2 projects visible to the owner via `gh project list`.
 */
async function listOwnerProjects(owner: string): Promise<RawProject[]> {
	const result = await execFileNoThrow('gh', [
		'project',
		'list',
		'--owner',
		owner,
		'--format',
		'json',
		'--limit',
		'100',
	]);
	if (result.exitCode !== 0) {
		throw new Error(`gh project list failed for owner "${owner}": ${result.stderr.trim()}`);
	}

	try {
		type ListResponse = { projects?: RawProject[] } | RawProject[];
		const parsed = JSON.parse(result.stdout) as ListResponse;
		return Array.isArray(parsed) ? parsed : (parsed.projects ?? []);
	} catch {
		throw new Error('gh project list returned invalid JSON');
	}
}

/**
 * Create a new Projects v2 project for the owner.
 */
async function createProject(owner: string, title: string): Promise<RawProject> {
	const result = await execFileNoThrow('gh', [
		'project',
		'create',
		'--owner',
		owner,
		'--title',
		title,
		'--format',
		'json',
	]);
	if (result.exitCode !== 0) {
		throw new Error(
			`gh project create failed for owner "${owner}", title "${title}": ${result.stderr.trim()}`
		);
	}

	try {
		return JSON.parse(result.stdout) as RawProject;
	} catch {
		throw new Error('gh project create returned invalid JSON');
	}
}
