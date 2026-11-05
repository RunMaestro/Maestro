/** Admission only: no Electron, stores, DB, providers, mkdir or process launches. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { canonicalJson } from '../../shared/canonicalJson';
import { parseJsonWithBom } from '../../shared/jsonUtils';
import { normalizeWorktreePath } from '../../shared/worktreePaths';
import { resolveUserDataDir } from '../../shared/userDataDir';
import { BOOTSTRAP_STORE_FILE, isValidSyncPath, resolveSyncDir } from '../../shared/syncPath';
import {
	foldPathCase,
	isPathWithin,
	realpathThroughAncestor,
} from '../utils/real-path-containment';

const PATH_ENV = {
	root: 'BOARD_ISOLATED_ROOT',
	db: 'BOARD_DB_PATH',
	userData: 'MAESTRO_USER_DATA',
	sync: 'BOARD_SYNC_PATH',
	agentRegistry: 'BOARD_AGENT_REGISTRY',
	sourceRegistry: 'BOARD_SOURCE_REGISTRY',
	sourceRoot: 'BOARD_SOURCE_ROOT',
} as const;

export interface BoardIsolation {
	readonly identity: string;
	readonly worktree: string;
	readonly root: string;
	readonly db: string;
	readonly userData: string;
	readonly sync: string;
	readonly agentRegistry: string;
	readonly sourceRegistry: string;
	readonly sourceRoot: string;
}

let processContract: BoardIsolation | undefined;

function refuse(reason: string): never {
	throw new Error(`Board isolation refused: ${reason}`);
}

/** realpathThroughAncestor is permissive on errors; admission must disambiguate them first. */
function checkedPath(value: unknown, label: string, kind: 'file' | 'directory'): string {
	if (
		typeof value !== 'string' ||
		!value ||
		!path.isAbsolute(value) ||
		value.includes('\0') ||
		value.split(/[/\\]/).some((part) => part === '..' || part === '.')
	)
		refuse(`${label} requires an explicit absolute path without traversal`);
	const normalized = path.normalize(value);
	const root = path.parse(normalized).root;
	if (normalized === root) refuse(`${label} cannot be a filesystem root`);
	const parts = path.relative(root, normalized).split(path.sep);
	let current = root;
	let ancestor = root;
	let missing = false;
	for (let i = 0; i < parts.length; i++) {
		current = path.join(current, parts[i]);
		if (missing) continue;
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			missing = true;
			continue;
		}
		if (stat.isSymbolicLink()) refuse(`${label} contains a symlink alias: ${current}`);
		const directory = i < parts.length - 1 || kind === 'directory';
		if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) {
			refuse(`${label} has an ambiguous file type or hard link: ${current}`);
		}
		ancestor = current;
	}
	const physicalAncestor = fs.realpathSync.native(ancestor);
	const expected = path.join(physicalAncestor, path.relative(ancestor, normalized));
	const physical = realpathThroughAncestor(normalized);
	if (
		foldPathCase(physical) !== foldPathCase(expected) ||
		foldPathCase(physical) !== foldPathCase(normalized)
	) {
		refuse(`${label} does not resolve unambiguously`);
	}
	return physical;
}

function inside(child: string, parent: string): boolean {
	return isPathWithin(foldPathCase(child), foldPathCase(parent));
}

/** Bundles lose their source dirname. Only a separate parent contract may restore that anchor. */
function checkoutAnchor(
	supplied: string | undefined,
	expected: BoardIsolation | undefined
): string {
	const moduleTree = path.dirname(path.dirname(__dirname));
	const nativeModule =
		path.basename(__dirname) === 'board' &&
		path.basename(path.dirname(__dirname)) === 'main' &&
		['src', 'dist'].includes(path.basename(moduleTree));
	const codeRoot = nativeModule ? path.dirname(moduleTree) : undefined;
	const worktree = checkedPath(supplied ?? expected?.worktree ?? codeRoot, 'worktree', 'directory');
	const key = (value: string): string =>
		foldPathCase(normalizeWorktreePath(value, process.platform !== 'win32'));
	if (codeRoot) {
		if (key(worktree) !== key(checkedPath(codeRoot, 'loaded checkout', 'directory')))
			refuse('worktree differs from the loaded checkout');
	} else if (
		!expected ||
		key(worktree) !== key(checkedPath(process.cwd(), 'bundled process cwd', 'directory'))
	) {
		// PWD and BOARD_ISOLATION_CONTRACT are environment claims, not an independent anchor.
		refuse('bundled code requires a parent contract and matching checkout cwd');
	}
	if (
		expected &&
		key(worktree) !== key(checkedPath(expected.worktree, 'parent checkout', 'directory'))
	)
		refuse('worktree differs from the parent checkout');

	const marker = path.join(worktree, '.git');
	const gitMarker = fs.lstatSync(marker);
	checkedPath(marker, 'checkout git marker', gitMarker.isDirectory() ? 'directory' : 'file');
	let gitDirectory = marker;
	if (gitMarker.isFile()) {
		const reference = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(fs.readFileSync(marker, 'utf8'));
		if (!reference) refuse('invalid checkout git marker');
		gitDirectory = checkedPath(
			path.resolve(worktree, reference[1]),
			'checkout git directory',
			'directory'
		);
		const backlink = fs
			.readFileSync(
				checkedPath(path.join(gitDirectory, 'gitdir'), 'worktree backlink', 'file'),
				'utf8'
			)
			.trim();
		if (
			!backlink ||
			key(checkedPath(path.resolve(gitDirectory, backlink), 'registered checkout', 'file')) !==
				key(marker)
		)
			refuse('git worktree registration differs from the checkout');
	}
	// A directory or an arbitrary .git file alone is not proof of a checkout.
	const head = fs.readFileSync(
		checkedPath(path.join(gitDirectory, 'HEAD'), 'checkout HEAD', 'file'),
		'utf8'
	);
	if (!/^(?:ref: refs\/[^\s]+|[a-fA-F0-9]{40}|[a-fA-F0-9]{64})\r?\n?$/.test(head))
		refuse('invalid checkout HEAD');
	return worktree;
}

/** Board fixtures and test harnesses opt in; ordinary demo mode is independent. */
export function isBoardIsolationRequested(env = process.env): boolean {
	return (
		(env === process.env && !!processContract) ||
		!!env.MAESTRO_E2E_TEST ||
		env.NODE_ENV === 'test' ||
		!!env.VITEST ||
		env.BOARD_ISOLATION_ID !== undefined ||
		env.BOARD_ISOLATION_CONTRACT !== undefined ||
		Object.values(PATH_ENV).some((key) => key !== 'MAESTRO_USER_DATA' && env[key] !== undefined)
	);
}

/** Every call revalidates the filesystem and environment; a previous admission is not a lease. */
export function requireBoardIsolation(
	options: {
		env?: NodeJS.ProcessEnv;
		worktree?: string;
		productionUserData?: string;
		expected?: BoardIsolation;
	} = {}
): BoardIsolation {
	const env = options.env ?? process.env;
	const identity = env.BOARD_ISOLATION_ID;
	if (!identity || !/^[a-zA-Z0-9_-]{1,128}$/.test(identity))
		refuse('missing explicit BOARD_ISOLATION_ID');
	const retained = env === process.env ? processContract : undefined;
	const expected = options.expected ?? retained;
	if (retained && expected && canonicalJson(retained) !== canonicalJson(expected))
		refuse('parent contract differs from the retained process contract');
	const worktree = checkoutAnchor(options.worktree, expected);
	const paths = Object.fromEntries(
		Object.entries(PATH_ENV).map(([key, variable]) => [
			key,
			checkedPath(
				env[variable],
				variable,
				['db', 'agentRegistry', 'sourceRegistry'].includes(key) ? 'file' : 'directory'
			),
		])
	) as Pick<BoardIsolation, keyof typeof PATH_ENV>;
	const isolated = path.join(worktree, 'isolated');
	if (!inside(paths.root, isolated) || foldPathCase(paths.root) === foldPathCase(isolated)) {
		refuse('root must be beneath the loaded worktree isolated/ directory');
	}
	for (const [key, value] of Object.entries(paths)) {
		if (
			key !== 'root' &&
			(!inside(value, paths.root) || foldPathCase(value) === foldPathCase(paths.root))
		) {
			refuse(`${key} must be strictly beneath the isolated root`);
		}
	}
	const files = [paths.db, paths.agentRegistry, paths.sourceRegistry];
	for (const file of files) {
		if (Object.values(paths).some((other) => other !== file && inside(other, file)))
			refuse('storage paths overlap');
	}
	if (new Set(files.map((p) => foldPathCase(p))).size !== files.length)
		refuse('storage files overlap');
	for (const file of [paths.agentRegistry, paths.sourceRegistry]) {
		if (path.extname(file) !== '.json' || !path.basename(file, '.json'))
			refuse('registry must name a JSON file');
	}
	if (!isValidSyncPath(paths.sync)) refuse('invalid isolated sync path');
	for (const variable of ['MAESTRO_DEMO_DIR', 'MAESTRO_DATA_DIR']) {
		if (
			env[variable] !== undefined &&
			checkedPath(env[variable], variable, 'directory') !== paths.userData
		) {
			refuse(`${variable} disagrees with userData`);
		}
	}

	// Deny both on-disk spellings, the dev profile, and the actual Electron path.
	// Only bootstrap location metadata is read; no production store/registry is opened.
	// HOME may intentionally name the fixture home. It cannot hide the real user's profile.
	const nativeHome = os.userInfo().homedir;
	const production = resolveUserDataDir({ env: {}, homedir: nativeHome, isDevelopment: false });
	const productionRoots = new Set([
		production,
		...['Maestro', 'maestro', 'maestro-dev'].map((name) =>
			path.join(path.dirname(production), name)
		),
	]);
	const observed =
		options.productionUserData ??
		resolveUserDataDir({
			env: { ...env, MAESTRO_USER_DATA: undefined },
			isDevelopment: false,
		});
	const fixtureHome =
		env.HOME && env.HOME !== nativeHome
			? checkedPath(env.HOME, 'fixture HOME', 'directory')
			: undefined;
	if (fixtureHome && !inside(fixtureHome, paths.root)) refuse('fixture HOME escapes isolated root');
	if (!fixtureHome || !inside(observed, fixtureHome)) productionRoots.add(observed);
	for (const candidate of productionRoots) {
		const denied = realpathThroughAncestor(candidate);
		if (inside(paths.root, denied) || inside(denied, paths.root))
			refuse('root overlaps production userData');
		const sync = realpathThroughAncestor(resolveSyncDir(candidate));
		if (inside(paths.root, sync) || inside(sync, paths.root))
			refuse('root overlaps production sync');
		// resolveSyncDir intentionally falls back for a missing custom directory.
		// Admission must also deny that configured destination before it is created.
		let bootstrap: { customSyncPath?: unknown } | null;
		try {
			bootstrap = parseJsonWithBom(
				fs.readFileSync(path.join(candidate, BOOTSTRAP_STORE_FILE), 'utf8')
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw error;
		}
		if (bootstrap?.customSyncPath !== undefined) {
			if (
				typeof bootstrap.customSyncPath !== 'string' ||
				!isValidSyncPath(bootstrap.customSyncPath)
			) {
				refuse('ambiguous production sync metadata');
			}
			const configured = realpathThroughAncestor(bootstrap.customSyncPath);
			if (inside(paths.root, configured) || inside(configured, paths.root))
				refuse('root overlaps configured production sync');
		}
	}
	const contract = Object.freeze({ identity, worktree, ...paths });
	if (expected && canonicalJson(contract) !== canonicalJson(expected)) {
		refuse('child identity or paths differ from its parent contract');
	}
	if (env.BOARD_ISOLATION_CONTRACT && env.BOARD_ISOLATION_CONTRACT !== canonicalJson(contract)) {
		refuse('inherited identity or paths were replaced');
	}
	if (env === process.env) processContract = contract;
	return contract;
}

/** Explicit parent binding travels in args too: children must pass expected and admit before any IO. */
export function boardIsolationChildEnv(
	contract: BoardIsolation,
	env = process.env
): NodeJS.ProcessEnv {
	requireBoardIsolation({ env, worktree: contract.worktree, expected: contract });
	return { ...env, BOARD_ISOLATION_CONTRACT: canonicalJson(contract) };
}

/** Use immediately before opening a derived store/DB path, including existing leaf aliases. */
export function assertBoardIsolationPath(
	contract: BoardIsolation,
	value: string,
	kind: 'file' | 'directory' = 'file'
): string {
	const physical = checkedPath(value, 'storage path', kind);
	if (!inside(physical, contract.root) || foldPathCase(physical) === foldPathCase(contract.root)) {
		refuse('storage path escapes isolated root');
	}
	return physical;
}

/** Admit every entry before any provider may use/open its root. Accept only fixture local registrations. */
export function assertBoardIsolationRegistrations(
	contract: BoardIsolation,
	registries: { sessions: unknown; sources: unknown }
): void {
	for (const [kind, entries] of Object.entries(registries)) {
		if (!Array.isArray(entries)) refuse(`${kind} registry must contain an explicit array`);
		const ids = new Set<string>();
		for (const value of entries) {
			if (!value || typeof value !== 'object') refuse(`invalid ${kind} registration`);
			const entry = value as Record<string, unknown>;
			if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id))
				refuse(`invalid or duplicate ${kind} id`);
			ids.add(entry.id);
			if (
				entry.sshRemoteId ||
				(entry.sessionSshRemoteConfig as { enabled?: unknown } | undefined)?.enabled ||
				(entry.location && (entry.location as { kind?: unknown }).kind !== 'local')
			)
				refuse('remote registration');
			const keys =
				kind === 'sources' ? ['root'] : ['cwd', 'fullPath', 'projectRoot', 'dir', 'worktreePath'];
			if (kind === 'sessions' && !entry.projectRoot && !entry.cwd && !entry.dir)
				refuse('agent root missing');
			for (const key of keys) {
				if (entry[key] === undefined && kind === 'sessions') continue;
				const root = checkedPath(entry[key], `${kind}.${key}`, 'directory');
				const allowed = kind === 'sources' ? contract.sourceRoot : contract.root;
				if (!inside(root, allowed)) refuse(`${kind}.${key} escapes admitted registration roots`);
			}
		}
	}
}

/** Read only admitted fixture files, after all paths pass and before stores/providers initialize. */
export function readBoardIsolationRegistries(
	contract: BoardIsolation,
	env = process.env
): { sessions: unknown; sources: unknown } {
	requireBoardIsolation({ env, expected: contract });
	const read = (file: string): Record<string, unknown> => {
		const value = parseJsonWithBom<unknown>(
			fs.readFileSync(checkedPath(file, 'registry', 'file'), 'utf8')
		);
		if (!value || typeof value !== 'object' || Array.isArray(value))
			refuse('invalid registry object');
		return value as Record<string, unknown>;
	};
	const registries = {
		sessions: read(contract.agentRegistry).sessions,
		sources: read(contract.sourceRegistry).sources,
	};
	assertBoardIsolationRegistrations(contract, registries);
	return registries;
}

/** Existing bootstrap metadata may not redirect an isolated store, even to another admitted directory. */
export function assertBoardIsolationBootstrap(contract: BoardIsolation, env = process.env): void {
	requireBoardIsolation({ env, expected: contract });
	const file = checkedPath(path.join(contract.userData, BOOTSTRAP_STORE_FILE), 'bootstrap', 'file');
	let raw: string;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw error;
	}
	const bootstrap = parseJsonWithBom<{ customSyncPath?: unknown }>(raw);
	if (
		!bootstrap ||
		typeof bootstrap !== 'object' ||
		Array.isArray(bootstrap) ||
		(bootstrap.customSyncPath !== undefined &&
			checkedPath(bootstrap.customSyncPath, 'customSyncPath', 'directory') !== contract.sync)
	) {
		refuse('bootstrap sync redirect differs from the explicit contract');
	}
}
