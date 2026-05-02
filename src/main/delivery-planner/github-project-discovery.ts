/**
 * GitHub Project Discovery — #447
 *
 * Discovers (or creates) the GitHub Projects v2 project for a given git repository.
 *
 * Flow:
 *   1. Verify `gh` CLI is installed and authenticated.
 *   2. Read `git remote get-url origin` → parse owner/repo (handles https:// and git@ forms)
 *   3. `gh project list --owner <owner> --format json` → find a candidate whose title
 *      contains the repo name (case-insensitive)
 *   4. If nothing matches → create a new project titled `<repo> AI Project`
 *   5. Return { owner, repo, projectNumber, projectId, projectTitle }
 *
 * The settings-store mapping is the persistent cache — this module only runs discovery
 * when a mapping is not yet stored for the given projectPath.
 *
 * All failure modes return a typed DiscoveryError with a structured `code` so the
 * renderer can surface a specific message + action (never silently no-ops).
 */

import { execFileNoThrow } from '../utils/execFile';
import type { ExecResult } from '../utils/execFile';
import type { AgentSshRemoteConfig } from '../../shared/types';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import { getSshRemoteConfig } from '../utils/ssh-remote-resolver';
import { buildSshCommand } from '../utils/ssh-command-builder';

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

/** Structured error codes returned by discoverGithubProject on each failure path. */
export type DiscoveryErrorCode =
	| 'GH_CLI_MISSING'
	| 'GH_AUTH_REQUIRED'
	| 'NOT_A_GIT_REPO'
	| 'NO_ORIGIN_REMOTE'
	| 'NOT_GITHUB'
	| 'NO_PROJECT_AND_CANNOT_CREATE'
	| 'MULTIPLE_MATCHES'
	| 'GH_CLI_OUTPUT_UNRECOGNIZED'
	| 'GH_PERMISSION_DENIED';

export interface DiscoveryError {
	code: DiscoveryErrorCode;
	message: string;
	/** Extra detail (e.g. stdout snippet for GH_CLI_OUTPUT_UNRECOGNIZED). */
	detail?: string;
	/** Candidate list returned when code is MULTIPLE_MATCHES. */
	candidates?: RawProject[];
}

/** Discriminated union result — avoids throwing for expected failure modes. */
export type DiscoveryResult =
	| { ok: true; mapping: GithubProjectMapping }
	| { ok: false; error: DiscoveryError };

// ---------------------------------------------------------------------------
// discoverGithubProject
// ---------------------------------------------------------------------------

export interface DiscoverGithubProjectOptions {
	projectPath: string;
	/** When set, git commands are run on the SSH remote instead of the local host. */
	sshRemoteConfig?: AgentSshRemoteConfig;
	/** Required when sshRemoteConfig is provided — used to resolve the SshRemoteConfig. */
	sshStore?: SshRemoteSettingsStore;
}

/**
 * Discover the GitHub Projects v2 project for the git repo rooted at `projectPath`.
 *
 * Returns a DiscoveryResult — never throws for expected failure modes.
 * Does NOT persist the result — callers (IPC handler) are responsible for saving
 * the mapping to the settings store.
 *
 * Pass `sshRemoteConfig` + `sshStore` to probe git on an SSH-remote host instead
 * of the local filesystem (required for sessions whose project lives on a remote).
 * The `gh` CLI calls always run locally — gh holds the user's GitHub auth.
 */
export async function discoverGithubProject(
	optsOrPath: DiscoverGithubProjectOptions | string
): Promise<DiscoveryResult> {
	// Support both legacy string form and new options object
	const opts: DiscoverGithubProjectOptions =
		typeof optsOrPath === 'string' ? { projectPath: optsOrPath } : optsOrPath;
	const { projectPath, sshRemoteConfig, sshStore } = opts;

	// 0. Pre-flight: gh CLI present and authenticated
	const preflight = await checkGhPreflight();
	if (!preflight.ok) return { ok: false, error: preflight.error };

	// 1. Resolve owner + repo from git remote
	const remoteResult = await parseGitRemote(projectPath, sshRemoteConfig, sshStore);
	if (!remoteResult.ok) return { ok: false, error: remoteResult.error };
	const { owner, repo } = remoteResult.coords;

	// 2. List existing projects for this owner
	const listResult = await listOwnerProjects(owner);
	if (!listResult.ok) return { ok: false, error: listResult.error };
	const projects = listResult.projects;

	// 3. Find matching candidates (title contains repo name, case-insensitive)
	const repoLower = repo.toLowerCase();
	const matches = projects.filter(
		(p) => typeof p.title === 'string' && p.title.toLowerCase().includes(repoLower)
	);

	if (matches.length === 1) {
		const candidate = matches[0];
		return {
			ok: true,
			mapping: {
				owner,
				repo,
				projectNumber: candidate.number,
				projectId: candidate.id,
				projectTitle: candidate.title,
				discoveredAt: new Date().toISOString(),
			},
		};
	}

	if (matches.length > 1) {
		return {
			ok: false,
			error: {
				code: 'MULTIPLE_MATCHES',
				message: `Found ${matches.length} matching Projects v2 for "${repo}". Pick one below.`,
				candidates: matches,
			},
		};
	}

	// 4. No matching project — attempt to create one
	const createResult = await createProject(owner, `${repo} AI Project`);
	if (!createResult.ok) return { ok: false, error: createResult.error };

	return {
		ok: true,
		mapping: {
			owner,
			repo,
			projectNumber: createResult.project.number,
			projectId: createResult.project.id,
			projectTitle: createResult.project.title,
			discoveredAt: new Date().toISOString(),
		},
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RemoteCoords {
	owner: string;
	repo: string;
}

type PreflightResult = { ok: true } | { ok: false; error: DiscoveryError };
type RemoteResult = { ok: true; coords: RemoteCoords } | { ok: false; error: DiscoveryError };
type ListResult = { ok: true; projects: RawProject[] } | { ok: false; error: DiscoveryError };
type CreateResult = { ok: true; project: RawProject } | { ok: false; error: DiscoveryError };

/**
 * Verify that the `gh` CLI is present on PATH and that the user is authenticated.
 */
async function checkGhPreflight(): Promise<PreflightResult> {
	// Check for gh CLI presence
	const versionResult = await execFileNoThrow('gh', ['--version']);
	if (versionResult.exitCode === 'ENOENT' || versionResult.exitCode === 'EACCES') {
		return {
			ok: false,
			error: {
				code: 'GH_CLI_MISSING',
				message: 'gh CLI not found. Install from https://cli.github.com/',
			},
		};
	}

	// Check authentication
	const authResult = await execFileNoThrow('gh', ['auth', 'status']);
	if (authResult.exitCode !== 0) {
		return {
			ok: false,
			error: {
				code: 'GH_AUTH_REQUIRED',
				message: 'Run: gh auth login',
				detail: authResult.stderr.trim() || authResult.stdout.trim(),
			},
		};
	}

	return { ok: true };
}

/**
 * Run `git -C <cwd> <args>` either locally or via SSH on a remote host.
 *
 * Returns the same shape as execFileNoThrow so callers are agnostic to local/remote.
 */
async function runGit(
	args: string[],
	cwd: string,
	sshRemoteConfig?: AgentSshRemoteConfig,
	sshStore?: SshRemoteSettingsStore
): Promise<ExecResult> {
	if (sshRemoteConfig?.enabled && sshStore) {
		const sshResult = getSshRemoteConfig(sshStore, { sessionSshConfig: sshRemoteConfig });
		if (sshResult.config) {
			const sshCmd = await buildSshCommand(sshResult.config, {
				command: 'git',
				args: ['-C', cwd, ...args],
			});
			return execFileNoThrow(sshCmd.command, sshCmd.args);
		}
	}
	// Local fallback: use -C flag so we don't need to change cwd
	return execFileNoThrow('git', ['-C', cwd, ...args]);
}

/**
 * Verify the path is a git repository and parse owner/repo from `git remote get-url origin`.
 *
 * Handles both:
 *   - https://github.com/owner/repo.git
 *   - git@github.com:owner/repo.git
 *
 * When sshRemoteConfig/sshStore are provided, git commands run on the remote host instead
 * of the local filesystem (so we never hit local fs.existsSync false-positives).
 */
async function parseGitRemote(
	cwd: string,
	sshRemoteConfig?: AgentSshRemoteConfig,
	sshStore?: SshRemoteSettingsStore
): Promise<RemoteResult> {
	// Verify the path is a git repo by running `git rev-parse --is-inside-work-tree`.
	// This works both locally and via SSH without needing filesystem access.
	const revParse = await runGit(
		['rev-parse', '--is-inside-work-tree'],
		cwd,
		sshRemoteConfig,
		sshStore
	);
	if (revParse.exitCode !== 0 || revParse.stdout.trim() !== 'true') {
		return {
			ok: false,
			error: {
				code: 'NOT_A_GIT_REPO',
				message: 'Project path is not a git repository',
				detail: `No .git directory found at "${cwd}"`,
			},
		};
	}

	const result = await runGit(['remote', 'get-url', 'origin'], cwd, sshRemoteConfig, sshStore);

	if (result.exitCode !== 0 || !result.stdout.trim()) {
		return {
			ok: false,
			error: {
				code: 'NO_ORIGIN_REMOTE',
				message: 'No origin remote configured. Set with: git remote add origin <url>',
				detail: result.stderr.trim() || 'git remote get-url origin returned no output',
			},
		};
	}

	const url = result.stdout.trim();

	// git@github.com:owner/repo.git  or  git@github.com:owner/repo
	const sshMatch = /git@([^:]+):([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
	if (sshMatch) {
		const host = sshMatch[1];
		if (!host.includes('github.com')) {
			return {
				ok: false,
				error: {
					code: 'NOT_GITHUB',
					message: 'Origin remote is not on github.com',
					detail: `Remote URL: ${url}`,
				},
			};
		}
		return { ok: true, coords: { owner: sshMatch[2], repo: sshMatch[3] } };
	}

	// https://github.com/owner/repo.git  or  https://github.com/owner/repo
	const httpsMatch = /https?:\/\/([^/]+)\/([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
	if (httpsMatch) {
		const host = httpsMatch[1];
		if (!host.includes('github.com')) {
			return {
				ok: false,
				error: {
					code: 'NOT_GITHUB',
					message: 'Origin remote is not on github.com',
					detail: `Remote URL: ${url}`,
				},
			};
		}
		return { ok: true, coords: { owner: httpsMatch[2], repo: httpsMatch[3] } };
	}

	return {
		ok: false,
		error: {
			code: 'GH_CLI_OUTPUT_UNRECOGNIZED',
			message: 'Origin remote is not on github.com',
			detail: `Unrecognised git remote URL format: "${url}"`,
		},
	};
}

export interface RawProject {
	id: string;
	number: number;
	title: string;
}

/**
 * Return all Projects v2 projects visible to the owner via `gh project list`.
 */
async function listOwnerProjects(owner: string): Promise<ListResult> {
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
		const stderr = result.stderr.trim();
		// Check for permission denied
		if (
			stderr.includes('permission') ||
			stderr.includes('403') ||
			stderr.includes('Forbidden') ||
			stderr.includes('unauthorized') ||
			stderr.includes('Unauthorized')
		) {
			return {
				ok: false,
				error: {
					code: 'GH_PERMISSION_DENIED',
					message: `Permission denied listing projects for owner "${owner}"`,
					detail: stderr,
				},
			};
		}
		return {
			ok: false,
			error: {
				code: 'GH_CLI_OUTPUT_UNRECOGNIZED',
				message: `gh project list failed for owner "${owner}"`,
				detail: stderr || result.stdout.slice(0, 300),
			},
		};
	}

	const raw = result.stdout.trim();
	try {
		type ListResponse = { projects?: RawProject[] } | RawProject[];
		const parsed = JSON.parse(raw) as ListResponse;
		const projects = Array.isArray(parsed) ? parsed : (parsed.projects ?? []);

		// Validate shape: each item must have id, number, title
		if (
			!projects.every((p) => typeof p === 'object' && p !== null && 'number' in p && 'title' in p)
		) {
			return {
				ok: false,
				error: {
					code: 'GH_CLI_OUTPUT_UNRECOGNIZED',
					message: 'gh project list returned unexpected JSON shape (gh CLI version mismatch?)',
					detail: raw.slice(0, 300),
				},
			};
		}

		return { ok: true, projects };
	} catch {
		return {
			ok: false,
			error: {
				code: 'GH_CLI_OUTPUT_UNRECOGNIZED',
				message: 'gh project list returned invalid JSON',
				detail: raw.slice(0, 300),
			},
		};
	}
}

/**
 * Create a new Projects v2 project for the owner.
 */
async function createProject(owner: string, title: string): Promise<CreateResult> {
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
		const stderr = result.stderr.trim();
		// Permission denied on create
		if (
			stderr.includes('permission') ||
			stderr.includes('403') ||
			stderr.includes('Forbidden') ||
			stderr.includes('unauthorized') ||
			stderr.includes('Unauthorized')
		) {
			return {
				ok: false,
				error: {
					code: 'NO_PROJECT_AND_CANNOT_CREATE',
					message: 'No Projects v2 found and cannot create one. Check user/org permissions.',
					detail: stderr,
				},
			};
		}
		return {
			ok: false,
			error: {
				code: 'NO_PROJECT_AND_CANNOT_CREATE',
				message: 'No Projects v2 found and cannot create one. Check user/org permissions.',
				detail: stderr || `gh project create failed for owner "${owner}", title "${title}"`,
			},
		};
	}

	const raw = result.stdout.trim();
	try {
		const parsed = JSON.parse(raw) as RawProject;
		if (typeof parsed.number !== 'number' || typeof parsed.title !== 'string') {
			return {
				ok: false,
				error: {
					code: 'GH_CLI_OUTPUT_UNRECOGNIZED',
					message: 'gh project create returned unexpected JSON shape',
					detail: raw.slice(0, 300),
				},
			};
		}
		return { ok: true, project: parsed };
	} catch {
		return {
			ok: false,
			error: {
				code: 'GH_CLI_OUTPUT_UNRECOGNIZED',
				message: 'gh project create returned invalid JSON',
				detail: raw.slice(0, 300),
			},
		};
	}
}
