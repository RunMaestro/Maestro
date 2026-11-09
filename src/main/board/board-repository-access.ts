import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/canonicalJson';
import { execGitReadOnly } from '../utils/remote-git';
import { foldPathCase, isPathWithin } from '../utils/real-path-containment';
import { resolveBoardLocation } from './board-location';
import { requireBoardEnabled } from './board-feature';

/** Native registers, not card input or a saved source hint. */
export interface BoardRepositoryAgent {
	id: string;
	groupId?: string | null;
	cwd?: string;
	dir?: string;
	projectRoot?: string;
	sshRemoteId?: unknown;
	sessionSshRemoteConfig?: { enabled?: boolean; remoteId?: unknown } | null;
}
interface LocalGitIdentity {
	root: string;
	common: string;
	/** Identity of native paths and Git's worktree registration, excluding mutable HEAD/index. */
	paths: {
		path: string;
		physical: string;
		identity: string;
		directory: boolean;
		reference?: string | null;
	}[];
}
export interface BoardRepositoryObservation {
	agents: string;
	repositories: string;
	identities: Record<string, LocalGitIdentity>;
	owners: Record<string, string[]>;
}
type Repository = {
	id: string;
	workingDirectory: string;
	validated: boolean;
	location?: { kind: 'local' } | { kind: 'ssh'; remoteId: string };
};

function agentBindings(agents: BoardRepositoryAgent[]): string {
	return canonicalJson(
		agents.map(({ id, groupId, cwd, dir, projectRoot, sshRemoteId, sessionSshRemoteConfig }) => ({
			id,
			groupId,
			cwd,
			dir,
			projectRoot,
			sshRemoteId,
			sessionSshRemoteConfig: sessionSshRemoteConfig
				? { enabled: sessionSshRemoteConfig.enabled, remoteId: sessionSshRemoteConfig.remoteId }
				: sessionSshRemoteConfig,
		}))
	);
}

function pathObservation(
	input: string,
	physical: string,
	stat: fs.Stats,
	contents?: Buffer
): LocalGitIdentity['paths'][number] {
	return {
		path: input,
		physical,
		directory: stat.isDirectory(),
		...(contents && ['.git', 'commondir', 'gitdir'].includes(path.basename(input))
			? {
					reference:
						path.basename(input) === '.git'
							? (/^gitdir: ([^\r\n]+)\r?\n?$/.exec(contents.toString('utf8'))?.[1] ?? null)
							: contents.toString('utf8').replace(/\r?\n$/, ''),
				}
			: {}),
		identity: canonicalJson([
			stat.dev,
			stat.ino,
			contents ? createHash('sha256').update(contents).digest('hex') : null,
		]),
	};
}
function observePath(input: string): LocalGitIdentity['paths'][number] {
	const physical = fs.realpathSync.native(input);
	const stat = fs.statSync(physical);
	return pathObservation(
		input,
		physical,
		stat,
		stat.isFile() ? fs.readFileSync(physical) : undefined
	);
}
async function observePathAsync(input: string): Promise<LocalGitIdentity['paths'][number]> {
	requireBoardEnabled();
	const physical = await fs.promises.realpath(input);
	requireBoardEnabled();
	const stat = await fs.promises.stat(physical);
	requireBoardEnabled();
	const contents = stat.isFile() ? await fs.promises.readFile(physical) : undefined;
	requireBoardEnabled();
	return pathObservation(input, physical, stat, contents);
}

/** Git proves the common directory and registered worktrees; physical identities bind that
 * answer across the await and synchronous claim/start fences. No remote URL equivalence. */
async function localIdentity(cwd: string): Promise<LocalGitIdentity | null> {
	try {
		requireBoardEnabled();
		// A process-wide Git override cannot prove the repository actually at an
		// agent's CWD. Never promote that ambiguous environment into default access.
		if (['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE'].some((key) => !!process.env[key]))
			return null;
		const input = await observePathAsync(cwd);
		const physical = input.physical;
		const args = [
			'rev-parse',
			'--path-format=absolute',
			'--show-toplevel',
			'--absolute-git-dir',
			'--git-common-dir',
		];
		const answer = await execGitReadOnly(args, physical);
		requireBoardEnabled();
		if (answer.exitCode !== 0) return null;
		const lines = answer.stdout.trim().split('\n');
		if (lines.length !== 3 || lines.some((line) => !path.isAbsolute(line))) return null;
		const [root, gitDir, common] = await Promise.all(
			lines.map((line) => fs.promises.realpath(line))
		);
		requireBoardEnabled();
		if (!isPathWithin(foldPathCase(physical), foldPathCase(root))) return null;
		const paths = [
			cwd,
			physical,
			root,
			common,
			gitDir,
			path.join(root, '.git'),
			path.join(common, 'config'),
		];
		let registeredRoot = root;
		if (foldPathCase(gitDir) !== foldPathCase(common)) {
			paths.push(path.join(gitDir, 'commondir'), path.join(gitDir, 'gitdir'));
			const backlink = (await fs.promises.readFile(path.join(gitDir, 'gitdir'), 'utf8')).trim();
			requireBoardEnabled();
			if (!path.isAbsolute(backlink) || path.basename(backlink) !== '.git') return null;
			registeredRoot = path.dirname(backlink);
			const physicalRegistration = await observePathAsync(registeredRoot);
			if (foldPathCase(physicalRegistration.physical) !== foldPathCase(root)) return null;
			paths.push(registeredRoot);
		}
		const before = await Promise.all(paths.map(observePathAsync));
		if (canonicalJson(input) !== canonicalJson(before[0])) return null;
		const marker = before.find((entry) => entry.path === path.join(root, '.git'))!;
		const declaredGitDir = marker.directory
			? marker.physical
			: marker.reference
				? path.resolve(root, marker.reference)
				: undefined;
		if (!declaredGitDir) return null;
		const gitBinding = await observePathAsync(declaredGitDir);
		if (foldPathCase(gitBinding.physical) !== foldPathCase(gitDir)) return null;
		paths.push(declaredGitDir);
		before.push(gitBinding);
		if (foldPathCase(gitDir) !== foldPathCase(common)) {
			const reference = before.find(
				(entry) => entry.path === path.join(gitDir, 'commondir')
			)?.reference;
			if (!reference || /[\r\n\0]/.test(reference)) return null;
			const declaredCommon = path.resolve(gitDir, reference);
			const commonBinding = await observePathAsync(declaredCommon);
			if (foldPathCase(commonBinding.physical) !== foldPathCase(common)) return null;
			paths.push(declaredCommon);
			before.push(commonBinding);
		}
		const registered = await execGitReadOnly(['worktree', 'list', '--porcelain', '-z'], physical);
		requireBoardEnabled();
		if (registered.exitCode !== 0) return null;
		const confirmed = await execGitReadOnly(args, physical);
		requireBoardEnabled();
		const roots = registered.stdout.split('\0').filter((line) => line.startsWith('worktree '));
		const after = await Promise.all(paths.map(observePathAsync));
		if (
			confirmed.exitCode !== 0 ||
			confirmed.stdout !== answer.stdout ||
			roots.filter((line) =>
				[root, registeredRoot].some(
					(candidate) => foldPathCase(path.normalize(line.slice(9))) === foldPathCase(candidate)
				)
			).length !== 1 ||
			canonicalJson(before) !== canonicalJson(after)
		)
			return null;
		return { root, common, paths: before };
	} catch (error) {
		if (
			!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(
				(error as NodeJS.ErrnoException).code ?? ''
			)
		)
			throw error;
		return null;
	}
}

/** One lookup, never a cache or persisted grant. Only the requested repositories are probed. */
export async function prepareBoardRepositoryAccess(
	agents: BoardRepositoryAgent[],
	repositories: Repository[]
): Promise<BoardRepositoryObservation> {
	requireBoardEnabled();
	const observation: BoardRepositoryObservation = {
		agents: agentBindings(agents),
		repositories: canonicalJson(repositories),
		identities: {},
		owners: {},
	};
	const localAgents = agents.flatMap((agent) => {
		const cwd = agent.cwd;
		return resolveBoardLocation(agent).kind === 'local' &&
			typeof cwd === 'string' &&
			!!cwd.trim() &&
			path.isAbsolute(cwd)
			? [{ agent, cwd }]
			: [];
	});
	if (!localAgents.length) return observation;
	const probed = new Map<string, Promise<LocalGitIdentity | null>>();
	const probe = (cwd: string) => {
		let pending = probed.get(cwd);
		if (!pending) {
			pending = localIdentity(cwd);
			probed.set(cwd, pending);
		}
		return pending;
	};
	for (const repository of repositories) {
		requireBoardEnabled();
		if (!repository.validated || (repository.location && repository.location.kind !== 'local'))
			continue;
		const identity = await probe(repository.workingDirectory);
		requireBoardEnabled();
		if (!identity || foldPathCase(identity.paths[0].physical) !== foldPathCase(identity.root))
			continue;
		observation.identities[repository.id] = identity;
		for (const { agent, cwd } of localAgents) {
			const own = await probe(cwd);
			requireBoardEnabled();
			if (!own || foldPathCase(own.common) !== foldPathCase(identity.common)) continue;
			// Retain both the worker CWD and target registration through the final start boundary.
			observation.identities['agent:' + agent.id] = own;
			(observation.owners[agent.id] ??= []).push(repository.id);
		}
	}
	return observation;
}

/** Read-only projection of a completed async observation, never launch authority. */
export function projectBoardRepositoryAccess(
	observation: BoardRepositoryObservation | undefined,
	agents: BoardRepositoryAgent[],
	repositories: Repository[]
): Record<string, string[]> {
	if (
		!observation ||
		observation.agents !== agentBindings(agents) ||
		observation.repositories !== canonicalJson(repositories)
	)
		return {};
	return observation.owners;
}

/** Fresh synchronous native path fence used only for claim/start/result authority. */
export function currentBoardRepositoryAccess(
	observation: BoardRepositoryObservation | undefined,
	agents: BoardRepositoryAgent[],
	repositories: Repository[]
): Record<string, string[]> {
	if (
		!observation ||
		projectBoardRepositoryAccess(observation, agents, repositories) !== observation.owners
	)
		return {};
	try {
		for (const identity of Object.values(observation.identities)) {
			if (
				canonicalJson(identity.paths) !==
				canonicalJson(identity.paths.map((entry) => observePath(entry.path)))
			)
				return {};
		}
		return observation.owners;
	} catch {
		return {};
	} // A read failure is absence of authority, never permission.
}
