/**
 * The local facts pack for a playbook's configure step (see
 * `src/shared/playbookFacts.ts`). Gathers what Maestro can learn about an
 * agent's workspace without spending tokens: git branch and remote, open pull
 * requests for the branch, whether `gh` and `python3` exist, Encore flags, how
 * many Cue subscriptions the agent owns, and the Obsidian vaults on the host.
 *
 * Every probe is best-effort: a missing tool or a folder that is not a repo is
 * an answer (`false`, absent), never an error, and {@link gatherPlaybookFacts}
 * never rejects. For an SSH agent the git, tool, and Obsidian probes run on the remote;
 * when the remote cannot be resolved or reached they are reported in
 * `unknownProbes` rather than answered from this machine.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CueSessionStatus } from '../../shared/cue/contracts';
import {
	resolveEncoreFeatures,
	type EncoreFeatureDefaults,
} from '../../shared/encoreFeatureDefaults';
import {
	createSshRemoteStoreAdapter,
	resolveSshLaunchTarget,
} from '../../shared/maestro-lib/launch/ssh-remote-resolver';
import type {
	PlaybookFactProbe,
	PlaybookFacts,
	PlaybookObsidianVault,
} from '../../shared/playbookFacts';
import { isMacOS, isWindows } from '../../shared/platformDetection';
import { isSshConnectionFailure } from '../../shared/sshConnection';
import type { SshRemoteConfig } from '../../shared/types';
import { getLiveSessions, getSettingsStore } from '../stores/getters';
import type { StoredSession } from '../stores/types';
import { getExpandedEnv } from '../utils/cliDetection';
import { execFileNoThrow, type ExecResult } from '../utils/execFile';
import { resolveConfiguredGhCommand } from '../utils/gh-command';
import { logger } from '../utils/logger';
import { execGitReadOnly, execShellRemote } from '../utils/remote-git';
import { shellEscapeRemotePath } from '../utils/shell-escape';
import { captureException } from '../utils/sentry';

const LOG_CONTEXT = '[PlaybookFacts]';

/** Per-probe budget. The configure step waits on the slowest one. */
export const PLAYBOOK_FACT_PROBE_TIMEOUT_MS = 8_000;

/** Where the facts come from. Injected so tests need no stores or Cue engine. */
export interface PlaybookFactsDeps {
	getSession: (sessionId: string) => StoredSession | undefined;
	getSshRemotes: () => SshRemoteConfig[];
	getEncoreFeatures: () => unknown;
	/** The Cue engine's per-agent status; absent or null when Cue is not running. */
	getCueStatus?: () => CueSessionStatus[] | null | undefined;
	/** The gh binary to run (honours Settings > GitHub CLI Path). */
	resolveGhCommand: () => Promise<string>;
	/** A local file's text, or null when it does not exist. */
	readLocalFile: (filePath: string) => Promise<string | null>;
	/** True when a local path is a directory. */
	isLocalDirectory: (dirPath: string) => Promise<boolean>;
}

async function readLocalFile(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

async function isLocalDirectory(dirPath: string): Promise<boolean> {
	try {
		return (await fs.stat(dirPath)).isDirectory();
	} catch {
		// Missing or unreadable: either way it is not a vault we can use.
		return false;
	}
}

/** Production wiring: live agents, the settings store, and the running Cue engine. */
export function createPlaybookFactsDeps(
	getCueStatus?: PlaybookFactsDeps['getCueStatus']
): PlaybookFactsDeps {
	return {
		getSession: (sessionId) => getLiveSessions().find((session) => session.id === sessionId),
		getSshRemotes: () => createSshRemoteStoreAdapter(getSettingsStore()).getSshRemotes(),
		getEncoreFeatures: () => getSettingsStore().get('encoreFeatures'),
		getCueStatus,
		resolveGhCommand: resolveConfiguredGhCommand,
		readLocalFile,
		isLocalDirectory,
	};
}

/** Where the probes run: this machine, an SSH remote, or nowhere we can reach. */
type ProbeHost =
	| { kind: 'local'; cwd: string }
	| { kind: 'remote'; cwd: string; remote: SshRemoteConfig }
	| { kind: 'unresolved'; cwd: string };

function resolveProbeHost(session: StoredSession, deps: PlaybookFactsDeps): ProbeHost {
	const sshConfig = session.sessionSshRemoteConfig;
	const target = resolveSshLaunchTarget({ getSshRemotes: deps.getSshRemotes }, sshConfig);
	if (target.kind === 'local') return { kind: 'local', cwd: session.cwd };
	const cwd = sshConfig?.workingDirOverride || session.cwd;
	if (target.kind === 'remote') return { kind: 'remote', cwd, remote: target.remote };
	return { kind: 'unresolved', cwd };
}

/**
 * Run one probe and turn anything it throws into its fallback. The exec
 * helpers never throw, so a throw is a bug: it goes to Sentry, not just a log.
 */
async function guarded<T>(probe: string, fallback: T, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		logger.warn(`Probe ${probe} failed`, LOG_CONTEXT, { error: String(error) });
		void captureException(error, { operation: `playbookFacts:${probe}` });
		return fallback;
	}
}

interface GitFacts {
	branch?: string;
	remoteUrl?: string;
	/** True when SSH never reached the host, so "no branch" means unknown. */
	unreachable: boolean;
}

async function probeGit(host: Exclude<ProbeHost, { kind: 'unresolved' }>): Promise<GitFacts> {
	const remote = host.kind === 'remote' ? host.remote : undefined;
	const remoteCwd = host.kind === 'remote' ? host.cwd : undefined;
	const git = (args: string[]) =>
		execGitReadOnly(args, host.cwd, remote, remoteCwd, PLAYBOOK_FACT_PROBE_TIMEOUT_MS);
	const [branchResult, remoteResult] = await Promise.all([
		git(['rev-parse', '--abbrev-ref', 'HEAD']),
		git(['remote', 'get-url', 'origin']),
	]);
	const answer = (result: ExecResult) =>
		result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
	const branch = answer(branchResult);
	return {
		// `HEAD` is git's answer for a detached checkout: there is no branch.
		branch: branch === 'HEAD' ? undefined : branch,
		remoteUrl: answer(remoteResult),
		unreachable:
			!!remote &&
			(isSshConnectionFailure(branchResult.exitCode) ||
				isSshConnectionFailure(remoteResult.exitCode)),
	};
}

/** True when `command --version` runs on this machine. */
async function localToolRuns(command: string): Promise<boolean> {
	const result = await execFileNoThrow(command, ['--version'], undefined, {
		env: getExpandedEnv(),
		timeout: PLAYBOOK_FACT_PROBE_TIMEOUT_MS,
	});
	return result.exitCode === 0;
}

interface ToolFacts {
	hasGh: boolean;
	hasPython3: boolean;
	unreachable: boolean;
}

/** Look for `gh` and `python3` on the remote's PATH in one SSH round trip. */
async function probeRemoteTools(remote: SshRemoteConfig): Promise<ToolFacts> {
	const result = await execShellRemote(
		'command -v gh >/dev/null 2>&1 && echo gh; command -v python3 >/dev/null 2>&1 && echo python3; exit 0',
		remote,
		{ timeoutMs: PLAYBOOK_FACT_PROBE_TIMEOUT_MS }
	);
	if (result.exitCode !== 0) {
		return { hasGh: false, hasPython3: false, unreachable: true };
	}
	const found = new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()));
	return { hasGh: found.has('gh'), hasPython3: found.has('python3'), unreachable: false };
}

/** `gh` and `python3` on the agent's host. */
async function probeTools(
	host: Exclude<ProbeHost, { kind: 'unresolved' }>,
	ghCommand: string
): Promise<ToolFacts> {
	if (host.kind === 'remote') {
		return guarded<ToolFacts>(
			'remote-tools',
			{ hasGh: false, hasPython3: false, unreachable: true },
			() => probeRemoteTools(host.remote)
		);
	}
	const [hasGh, hasPython3] = await Promise.all([
		guarded('gh', false, () => localToolRuns(ghCommand)),
		guarded('python3', false, () => localToolRuns('python3')),
	]);
	return { hasGh, hasPython3, unreachable: false };
}

/**
 * Open pull requests whose head is `branch`. Runs this machine's gh: a pull
 * request lives on GitHub, not on the agent's host. A local agent asks from
 * its own folder (so gh picks the repo, forks included); an SSH agent names
 * the repo by its remote URL.
 */
async function probeOpenPrs(
	ghCommand: string,
	branch: string,
	scope: { cwd: string } | { repo: string }
): Promise<string[]> {
	const args = ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url'];
	if ('repo' in scope) args.push('--repo', scope.repo);
	const result = await execFileNoThrow(ghCommand, args, 'cwd' in scope ? scope.cwd : undefined, {
		env: getExpandedEnv(),
		timeout: PLAYBOOK_FACT_PROBE_TIMEOUT_MS,
	});
	if (result.exitCode !== 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		// gh printed something other than JSON (an old gh, a warning banner).
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed
		.map((item) => (item && typeof item === 'object' ? (item as { url?: unknown }).url : null))
		.filter((url): url is string => typeof url === 'string' && url.length > 0);
}

interface ObsidianFacts {
	cwdIsVault: boolean;
	vaults: PlaybookObsidianVault[];
	/** True when SSH never reached the host. */
	unreachable: boolean;
}

/**
 * Vaults from the text of Obsidian's `obsidian.json` (`{ vaults: { <id>: {
 * path, open } } }`), in file order, duplicates dropped. Text that is not that
 * shape yields no vaults: a file Obsidian is mid-way through writing is an
 * answer of "none known", not an error.
 */
export function parseObsidianVaults(text: string): PlaybookObsidianVault[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const vaults = (parsed as { vaults?: unknown } | null)?.vaults;
	if (!vaults || typeof vaults !== 'object') return [];
	const seen = new Set<string>();
	const result: PlaybookObsidianVault[] = [];
	for (const entry of Object.values(vaults)) {
		const vaultPath = (entry as { path?: unknown } | null)?.path;
		if (typeof vaultPath !== 'string' || !vaultPath.trim() || seen.has(vaultPath)) continue;
		seen.add(vaultPath);
		result.push({ path: vaultPath, open: (entry as { open?: unknown }).open === true });
	}
	return result;
}

/** Where Obsidian keeps `obsidian.json` on this machine, most likely first. */
export function localObsidianConfigPaths(
	home = os.homedir(),
	env: NodeJS.ProcessEnv = process.env
): string[] {
	if (isWindows()) {
		return [
			path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'obsidian', 'obsidian.json'),
		];
	}
	if (isMacOS()) {
		return [path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json')];
	}
	return [
		path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'obsidian', 'obsidian.json'),
		// Flatpak and Snap installs keep their own config folder.
		path.join(home, '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json'),
		path.join(home, 'snap', 'obsidian', 'current', '.config', 'obsidian', 'obsidian.json'),
	];
}

async function probeLocalObsidian(cwd: string, deps: PlaybookFactsDeps): Promise<ObsidianFacts> {
	const cwdIsVault = cwd ? await deps.isLocalDirectory(path.join(cwd, '.obsidian')) : false;
	for (const configPath of localObsidianConfigPaths()) {
		const text = await deps.readLocalFile(configPath);
		if (text !== null) return { cwdIsVault, vaults: parseObsidianVaults(text), unreachable: false };
	}
	return { cwdIsVault, vaults: [], unreachable: false };
}

/** Marks the start of `obsidian.json` in the remote probe's output. */
const REMOTE_OBSIDIAN_CONFIG_MARKER = '--maestro-obsidian-json--';

/**
 * The same answers on an SSH remote in one round trip: `vault` when the
 * working directory holds `.obsidian/`, then the first `obsidian.json` found
 * (Linux, Flatpak, Snap, or macOS location) after a marker line.
 */
async function probeRemoteObsidian(cwd: string, remote: SshRemoteConfig): Promise<ObsidianFacts> {
	const configs = [
		'"${XDG_CONFIG_HOME:-$HOME/.config}/obsidian/obsidian.json"',
		'"$HOME/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json"',
		'"$HOME/snap/obsidian/current/.config/obsidian/obsidian.json"',
		'"$HOME/Library/Application Support/obsidian/obsidian.json"',
	].join(' ');
	const vaultCheck = cwd ? `[ -d ${shellEscapeRemotePath(cwd)}/.obsidian ] && echo vault; ` : '';
	const result = await execShellRemote(
		`${vaultCheck}for f in ${configs}; do if [ -f "$f" ]; then echo ${REMOTE_OBSIDIAN_CONFIG_MARKER}; cat "$f"; break; fi; done; exit 0`,
		remote,
		{ timeoutMs: PLAYBOOK_FACT_PROBE_TIMEOUT_MS }
	);
	if (result.exitCode !== 0) return { cwdIsVault: false, vaults: [], unreachable: true };
	const [head, ...config] = result.stdout.split(REMOTE_OBSIDIAN_CONFIG_MARKER);
	return {
		cwdIsVault: head.split(/\r?\n/).some((line) => line.trim() === 'vault'),
		vaults:
			config.length > 0 ? parseObsidianVaults(config.join(REMOTE_OBSIDIAN_CONFIG_MARKER)) : [],
		unreachable: false,
	};
}

/** Whether the working directory is a vault, and the vaults Obsidian knows, on the agent's host. */
function probeObsidian(
	host: Exclude<ProbeHost, { kind: 'unresolved' }>,
	deps: PlaybookFactsDeps
): Promise<ObsidianFacts> {
	const fallback: ObsidianFacts = {
		cwdIsVault: false,
		vaults: [],
		unreachable: host.kind === 'remote',
	};
	return guarded('obsidian', fallback, () =>
		host.kind === 'remote'
			? probeRemoteObsidian(host.cwd, host.remote)
			: probeLocalObsidian(host.cwd, deps)
	);
}

function cueSubscriptionCount(sessionId: string, deps: PlaybookFactsDeps): number {
	const status = deps.getCueStatus?.() ?? [];
	return status.find((entry) => entry.sessionId === sessionId)?.subscriptionCount ?? 0;
}

function readEncoreFlags(deps: PlaybookFactsDeps): EncoreFeatureDefaults {
	return resolveEncoreFeatures(deps.getEncoreFeatures());
}

/**
 * Gather the facts pack for one agent. Never rejects: an unknown agent yields
 * empty facts with every probe listed as unknown.
 */
export async function gatherPlaybookFacts(
	sessionId: string,
	deps: PlaybookFactsDeps
): Promise<PlaybookFacts> {
	const encoreFlags = await guarded('encore', resolveEncoreFeatures(undefined), async () =>
		readEncoreFlags(deps)
	);
	const cueCount = await guarded('cue', 0, async () => cueSubscriptionCount(sessionId, deps));
	const session = deps.getSession(sessionId);
	if (!session) {
		return {
			cwd: '',
			isSshRemote: false,
			openPrUrlsForBranch: [],
			hasGh: false,
			hasPython3: false,
			unknownProbes: ['git', 'gh', 'python3', 'obsidian'],
			encoreFlags,
			cueSubscriptionCount: cueCount,
			cwdIsObsidianVault: false,
			obsidianVaults: [],
		};
	}

	const host = resolveProbeHost(session, deps);
	const facts: PlaybookFacts = {
		cwd: host.cwd,
		isSshRemote: host.kind !== 'local',
		openPrUrlsForBranch: [],
		hasGh: false,
		hasPython3: false,
		unknownProbes: [],
		encoreFlags,
		cueSubscriptionCount: cueCount,
		cwdIsObsidianVault: false,
		obsidianVaults: [],
	};
	if (host.kind === 'unresolved') {
		facts.unknownProbes = ['git', 'gh', 'python3', 'obsidian'];
		return facts;
	}

	const unknown = new Set<PlaybookFactProbe>();
	const ghCommand = await guarded('gh-path', 'gh', deps.resolveGhCommand);
	const [git, tools, obsidian, prLookupGh] = await Promise.all([
		guarded<GitFacts>('git', { unreachable: true }, () => probeGit(host)),
		probeTools(host, ghCommand),
		probeObsidian(host, deps),
		// The PR lookup runs this machine's gh whatever the agent's host, so an
		// SSH agent needs its own check that the local gh runs.
		host.kind === 'remote' ? guarded('gh', false, () => localToolRuns(ghCommand)) : null,
	]);

	if (git.unreachable) unknown.add('git');
	else {
		facts.gitBranch = git.branch;
		facts.gitRemoteUrl = git.remoteUrl;
	}
	if (tools.unreachable) {
		unknown.add('gh');
		unknown.add('python3');
	} else {
		facts.hasGh = tools.hasGh;
		facts.hasPython3 = tools.hasPython3;
	}
	if (obsidian.unreachable) unknown.add('obsidian');
	else {
		facts.cwdIsObsidianVault = obsidian.cwdIsVault;
		facts.obsidianVaults = obsidian.vaults;
	}

	const branch = facts.gitBranch;
	const prScope =
		host.kind === 'local'
			? facts.hasGh && { cwd: host.cwd }
			: prLookupGh === true && facts.gitRemoteUrl && { repo: facts.gitRemoteUrl };
	if (branch && prScope) {
		facts.openPrUrlsForBranch = await guarded('pull-requests', [], () =>
			probeOpenPrs(ghCommand, branch, prScope)
		);
	}

	facts.unknownProbes = [...unknown];
	return facts;
}
