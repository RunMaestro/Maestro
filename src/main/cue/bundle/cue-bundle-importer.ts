/**
 * Cue bundle importer - materializes a bundle (`src/shared/cue-bundle-types.ts`)
 * into a Maestro data directory and the local folders its workspace keys map
 * to, so the CLI, the standalone Cue engine and the desktop app can all use it.
 *
 * It runs with the desktop app closed and never imports Electron: the CLI loads
 * it through a dynamic `import()`, and the engine-coupling ratchet
 * (`cue-electron-imports.test.ts`) covers this folder.
 *
 * Two phases:
 *
 * 1. **Plan** (`planCueBundleImport`) reads and checks EVERYTHING and writes
 *    nothing: bundle integrity and engine version, no Cue engine or desktop on
 *    the data dir, every workspace mapped to an existing folder, every target
 *    path contained in its root, every conflict. A dry run stops here.
 * 2. **Apply** (`importCueBundle`) writes in a fixed order: workspace files,
 *    data-dir Auto Run documents, playbooks, cue.yaml merges, the pipeline
 *    layout, provider binary paths, and the agent records LAST, so a failure
 *    partway never leaves an agent pointing at files that are not there. Each target's prior bytes were captured in phase 1,
 *    and a failed write puts every earlier target back.
 *
 * Every refusal is a {@link CueBundleImportError} with a stable `code`, so the
 * CLI can map it to an exit code and a JSON payload.
 *
 * Importing into the RUNNING desktop app goes through a {@link CueBundleImportHost}:
 * the app owns its agents in memory, so they come from it and go back to it
 * instead of through `maestro-sessions.json`, which it would overwrite.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { isWindows } from '../../../shared/platformDetection';
import type { CuePipeline, PipelineLayoutState } from '../../../shared/cue-pipeline-types';
import type { SessionInfo } from '../../../shared/types';
import {
	CUE_BUNDLE_AGENT_FIELDS,
	CUE_BUNDLE_CLAUDE_MEMORY_DIR,
	CUE_BUNDLE_LAYOUT_PATH,
	CUE_BUNDLE_MANIFEST_PATH,
	CUE_BUNDLE_README_PATH,
	type CueBundleAgentSettings,
	type CueBundleKind,
	type CueBundleManifest,
} from '../../../shared/cue-bundle-types';
import { CUE_CONFIG_PATH, PLAYBOOKS_DIR } from '../../../shared/maestro-paths';
import { isValidAgentId } from '../../../shared/agentIds';
import { getSettingDefault } from '../../../shared/settingsMetadata';
import { buildNewAgentRecord, newAgentClaudeInteractive } from '../../../shared/newAgentRecord';
import { generateUUID } from '../../../shared/uuid';
import { readCliServerInfo, isCliServerRunning } from '../../../shared/cli-server-discovery';
import { filterServerProcessEnv } from '../../../shared/maestro-lib/launch/env';
import {
	describeSecretProblem,
	isValidSecretName,
	lookupSecret,
	type SecretSource,
} from '../../../shared/serverSecrets';
import type { ThinkingMode } from '../../../shared/types';
import { assertNoSymlinkOnPath } from '../../utils/zip-archive';
import { atomicWriteFile } from '../../utils/atomic-json-store';
import {
	readSessionsStoreFile,
	SessionsStoreCorruptError,
	writeSessionsStoreFile,
	type SessionsStoreData,
} from '../../stores/sessions-store-file';
import {
	AgentConfigsStoreCorruptError,
	agentConfigsStorePath,
	readAgentConfigsStoreFile,
	writeAgentConfigsStoreFile,
	type AgentConfigsStoreData,
} from '../../stores/agent-configs-store-file';
import { readCueEngineLock } from '../cue-engine-lock';
import { sanitizeCustomEnvVars } from '../cue-env-sanitizer';
import { writeCueYamlAtomicSync } from '../cue-yaml-write';
import { mergeSubscriptionsIntoCueYaml } from '../cue-scheduled-tasks';
import { resolveCueConfigPath } from '../config/cue-config-repository';
import { loadPipelineLayout, savePipelineLayout } from '../pipeline-layout-store';
import { upsertPipeline, validatePipelineEntry } from '../pipeline-layout-mutations';
import {
	readCueBundleArchive,
	validateCueBundleArchive,
	type CueBundleArchive,
	type CueBundleValidationIssue,
} from './cue-bundle-validator';
import { isWithin } from './cue-bundle-exporter';
import {
	MCP_CONFIG_FILE,
	isClaudeMemoryFileName,
	mcpConfigSecretNames,
	mergeMcpConfig,
} from './cue-bundle-claude-assets';
import { claudeMemoryDir, resolveClaudeConfigDir } from '../../memory-manager';

// ─── Public types ───────────────────────────────────────────────────────────

export type CueBundleImportErrorCode =
	/** Options the caller passed are unusable (relative path, no bundle). */
	| 'INVALID_OPTIONS'
	/** The bundle file is missing, is not a zip, or trips the zip caps. */
	| 'BUNDLE_UNREADABLE'
	/** The bundle failed validation (integrity, version, references). */
	| 'BUNDLE_INVALID'
	/** A Cue engine holds the data directory's lock. */
	| 'ENGINE_RUNNING'
	/** A desktop app is running against the data directory. */
	| 'DESKTOP_RUNNING'
	/** The data dir's bootstrap names a custom sync folder the desktop reads agents from instead. */
	| 'SYNC_PATH_REDIRECT'
	/** A store file the import must extend exists but cannot be parsed. */
	| 'STORE_CORRUPT'
	/** A bundle workspace has no local folder mapped to it. */
	| 'WORKSPACE_UNMAPPED'
	/** A mapped workspace folder does not exist. */
	| 'WORKSPACE_NOT_FOUND'
	/** An agent's provider is not one this build knows. */
	| 'UNKNOWN_AGENT_TYPE'
	/** An agent's name belongs to a different existing agent. */
	| 'AGENT_NAME_TAKEN'
	/** A target path leaves its root or goes through a symlink. */
	| 'PATH_ESCAPE'
	/** A target path exists and is not a regular file. */
	| 'TARGET_NOT_A_FILE'
	/** A workspace's existing cue.yaml is not valid YAML. */
	| 'CUE_CONFIG_INVALID'
	/** Shell-command steps were refused by the caller. */
	| 'SHELL_COMMANDS_REFUSED'
	/** Conflicts with existing data, and `force` was not set. */
	| 'CONFLICTS'
	/** A write failed; earlier writes were rolled back. */
	| 'WRITE_FAILED';

export class CueBundleImportError extends Error {
	constructor(
		readonly code: CueBundleImportErrorCode,
		message: string,
		readonly details: Record<string, unknown> = {}
	) {
		super(message);
		this.name = 'CueBundleImportError';
	}
}

export type CueBundleImportLogLevel = 'info' | 'warn';

export interface CueBundleImportOptions {
	/** The bundle zip. */
	bundlePath: string;
	/** Target Maestro data directory. Created when missing (and logged). */
	dataDir: string;
	/** Bundle workspace key -> absolute local folder. Every key needs one. */
	workspaces: Record<string, string>;
	/** Version of the program importing (the CLI passes its own). */
	runningVersion: string;
	/** Plan and report only; write nothing. */
	dryRun?: boolean;
	/** Overwrite conflicting agents, subscriptions, playbooks, files and the layout entry. */
	force?: boolean;
	/** Refuse the import when any subscription runs a shell command. */
	refuseShellCommands?: boolean;
	/**
	 * Provider binary overrides, tool type -> absolute path, written to the
	 * data dir's `maestro-agent-configs.json` as `configs[toolType].customPath`.
	 * That provider-level path is what Cue, the CLI and the desktop launch; an
	 * agent record's own `customPath` is never read by Cue.
	 */
	agentPaths?: Record<string, string>;
	/**
	 * Environment consulted for required secrets (and for systemd's
	 * `CREDENTIALS_DIRECTORY`) and `CLAUDE_CONFIG_DIR`. Defaults to `process.env`.
	 */
	env?: NodeJS.ProcessEnv;
	/** Override the `/run/secrets` directory; `null` disables it. Tests use this. */
	runSecretsDir?: string | null;
	/** Claude's config directory, for imported auto memory. Defaults to `CLAUDE_CONFIG_DIR` or `~/.claude`. */
	claudeConfigDir?: string;
	/** Import into a running desktop app instead of its files. See {@link CueBundleImportHost}. */
	host?: CueBundleImportHost;
	onLog?: (level: CueBundleImportLogLevel, message: string) => void;
	/**
	 * Called with the plan once the import has passed every check, right
	 * before the first write; never for a dry run or a refusal. The CLI prints
	 * the plan here, so the shell commands it installs are on screen before
	 * anything lands. What is written is exactly this plan. A throw cancels the
	 * import with nothing written.
	 */
	onBeforeWrite?: (plan: CueBundleImportPlan) => void | Promise<void>;
}

/**
 * The running desktop app an import goes into. The app holds its agents in
 * memory and would overwrite `maestro-sessions.json` on its next save, so the
 * import reads the agents from it and hands the new and updated ones back.
 * Every other file is written as usual. The checks for an engine or app on
 * the data directory are skipped: the caller is that app, and its own Cue
 * engine picks up the merged cue.yaml files.
 */
export interface CueBundleImportHost {
	/** The app's agents right now. */
	sessions: SessionInfo[];
	/**
	 * Add `created` and replace `updated` (matched by id). Called last, after
	 * every file is written; a throw rolls the files back.
	 */
	applyAgents(change: { created: SessionInfo[]; updated: SessionInfo[] }): Promise<void>;
}

export type CueBundleImportConflictKind =
	| 'agent'
	| 'subscription'
	| 'playbooks'
	| 'file'
	| 'pipeline'
	| 'agent-path';

export interface CueBundleImportConflict {
	kind: CueBundleImportConflictKind;
	/** Agent id, subscription name, pipeline name, tool type, or file path. */
	target: string;
	message: string;
}

export type CueBundleImportFileKind = 'workspace' | 'autorun' | 'playbooks' | 'claude-memory';

export interface CueBundleImportFile {
	kind: CueBundleImportFileKind;
	/** Archive path. */
	source: string;
	/** Absolute local path. */
	target: string;
	action: 'create' | 'overwrite' | 'unchanged';
}

export interface CueBundleImportAgent {
	id: string;
	name: string;
	toolType: string;
	workspace: string;
	cwd: string;
	/** `create` for a new record; `update` overwrites an existing one's settings (force). */
	action: 'create' | 'update';
}

export interface CueBundleImportCueConfig {
	workspace: string;
	/** The canonical `.maestro/cue.yaml` written. */
	path: string;
	created: boolean;
	added: string[];
	replaced: string[];
	/** Subscriptions already present with identical content. */
	unchanged: string[];
	/** Settings keys the local file sets differently; the local value was kept. */
	settingsKept: string[];
	/** A legacy `maestro-cue.yaml` that is folded into the canonical file and removed. */
	legacyRemoved?: string;
}

export interface CueBundleImportShellCommand {
	workspace: string;
	subscription: string;
	command: string;
}

export interface CueBundleImportEnvReport {
	agentId: string;
	agentName: string;
	/** Variable names written to the agent. */
	kept: string[];
	/** Names the env sanitizer dropped (invalid or blocked). */
	dropped: string[];
	/** Names whose value was a path on the exporting machine; set them again. */
	machineSpecific: string[];
}

export interface CueBundleImportSecret {
	name: string;
	/**
	 * Whether this machine supplies it: a systemd credential, a
	 * `/run/secrets/<NAME>` file, or a non-empty environment variable, looked
	 * up exactly as the engine and the CLI will at launch.
	 */
	set: boolean;
	/** Where the value was found, when it was. */
	source?: SecretSource;
	/** Why a secret file that exists cannot be used (names the path, never the value). */
	problem?: string;
	/** Who reads it: `agent:<name>` or `webhook:<subscription>`. */
	usedBy: string[];
	/**
	 * For a secret an agent reads: whether server mode's inherited-env
	 * allowlist also lets it through. Informational: a declared secret reaches
	 * the agents that declared it either way (it is resolved per agent at
	 * launch), but one on the allowlist is ALSO inherited by every agent the
	 * engine runs whenever it is set in the engine's environment. Webhook
	 * secrets are read by the engine itself, so the allowlist does not apply.
	 */
	passesServerAllowlist?: boolean;
}

export interface CueBundleImportAgentPath {
	toolType: string;
	path: string;
	action: 'create' | 'overwrite' | 'unchanged';
	/** The provider's binary path before the import, when it had one. */
	previous?: string;
}

export interface CueBundleImportPlan {
	bundle: { name: string; kind: CueBundleKind; producerVersion: string };
	dataDir: string;
	/** True when the data directory does not exist yet and will be created. */
	createDataDir: boolean;
	agents: CueBundleImportAgent[];
	files: CueBundleImportFile[];
	cueConfigs: CueBundleImportCueConfig[];
	pipeline?: { id: string; name: string; action: 'create' | 'overwrite' | 'unchanged' };
	agentPaths: CueBundleImportAgentPath[];
	shellCommands: CueBundleImportShellCommand[];
	env: CueBundleImportEnvReport[];
	secrets: CueBundleImportSecret[];
	conflicts: CueBundleImportConflict[];
	warnings: string[];
}

export interface CueBundleImportResult {
	plan: CueBundleImportPlan;
	/** False for a dry run. */
	applied: boolean;
}

// ─── Internal plan ──────────────────────────────────────────────────────────

/** One write the apply phase performs, with what was there before it. */
interface PlannedWrite {
	target: string;
	/** Bytes to write, or null to delete the target. */
	content: Buffer | string | null;
	/** The target's bytes at plan time, or null when it did not exist. */
	before: Buffer | null;
	via: 'file' | 'cue-yaml' | 'layout' | 'agent-configs';
	/** Set the executable bit after writing (a skill's script). */
	executable?: boolean;
}

interface InternalPlan {
	plan: CueBundleImportPlan;
	/** In write order; the sessions store is handled separately, last. */
	writes: PlannedWrite[];
	layout?: PipelineLayoutState;
	agentConfigsData?: AgentConfigsStoreData;
	sessionsData: SessionsStoreData;
	sessionsBefore: Buffer | null;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

/**
 * The secret names an agent record keeps: valid env var names only (a name is
 * also a file name under `/run/secrets`, so nothing with a separator or `..`
 * is stored), de-duplicated and sorted so a re-import writes the same record.
 * `undefined` when there are none, so the field is simply absent.
 */
function requiredSecretNames(value: unknown): string[] | undefined {
	const names = [...new Set(asStringList(value).filter(isValidSecretName))].sort();
	return names.length > 0 ? names : undefined;
}

function asStringList(value: unknown): string[] {
	if (typeof value === 'string') return value ? [value] : [];
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && !!v);
	return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readIfExists(filePath: string): Buffer | null {
	try {
		return fs.readFileSync(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

function realpathOrResolve(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
	const raw = readIfExists(filePath);
	if (!raw) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw.toString('utf-8'));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function formatIssues(issues: CueBundleValidationIssue[]): string {
	return issues.map((i) => `[${i.code}] ${i.message}${i.file ? ` (${i.file})` : ''}`).join('; ');
}

/**
 * Resolve `relPosix` beneath `root` and prove it stays there: lexically, and
 * with no existing symlink on the way (the same rule zip extraction applies).
 */
function containedTarget(root: string, relPosix: string, what: string): string {
	const realRoot = realpathOrResolve(root);
	const target = path.join(realRoot, ...relPosix.split('/'));
	if (target === realRoot || !isWithin(realRoot, target)) {
		throw new CueBundleImportError('PATH_ESCAPE', `${what} resolves outside ${root}`, {
			root,
			path: relPosix,
		});
	}
	try {
		assertNoSymlinkOnPath(realRoot, target);
	} catch (error) {
		throw new CueBundleImportError(
			'PATH_ESCAPE',
			`${what} would be written through a symlink: ${error instanceof Error ? error.message : String(error)}`,
			{ root, path: relPosix }
		);
	}
	return target;
}

/** The current bytes of a target that must be a regular file when it exists. */
function fileBefore(target: string): Buffer | null {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	if (!stat.isFile()) {
		throw new CueBundleImportError('TARGET_NOT_A_FILE', `${target} exists and is not a file`, {
			path: target,
		});
	}
	return fs.readFileSync(target);
}

// ─── Gates ──────────────────────────────────────────────────────────────────

/**
 * Refuse while anything else may be writing the data directory: a Cue engine
 * holding its lock (desktop or standalone), or a desktop app whose discovery
 * file in THIS directory names a live process. A discovery file left by a dead
 * process is stale and ignored.
 */
function assertDataDirIdle(
	dataDir: string,
	log: (level: CueBundleImportLogLevel, m: string) => void
): void {
	const lock = readCueEngineLock(dataDir);
	if (lock) {
		throw new CueBundleImportError(
			'ENGINE_RUNNING',
			`A ${lock.mode} Cue engine (PID ${lock.pid}) is running against ${dataDir}. Stop it before importing.`,
			{ pid: lock.pid, mode: lock.mode }
		);
	}
	const discovery = readCliServerInfo(dataDir);
	if (discovery) {
		if (isCliServerRunning(dataDir)) {
			throw new CueBundleImportError(
				'DESKTOP_RUNNING',
				`The Maestro desktop app (PID ${discovery.pid}) is running against ${dataDir}. Quit it before importing.`,
				{ pid: discovery.pid }
			);
		}
		log(
			'warn',
			`Ignoring a stale desktop discovery file in ${dataDir} (PID ${discovery.pid} is not running).`
		);
	}
}

// ─── Planning ───────────────────────────────────────────────────────────────

async function buildPlan(options: CueBundleImportOptions): Promise<InternalPlan> {
	const log = options.onLog ?? (() => {});
	if (!options.bundlePath) {
		throw new CueBundleImportError('INVALID_OPTIONS', 'A bundle path is required');
	}
	if (!options.dataDir || !path.isAbsolute(options.dataDir)) {
		throw new CueBundleImportError(
			'INVALID_OPTIONS',
			'The data directory must be an absolute path',
			{
				dataDir: options.dataDir,
			}
		);
	}
	const dataDir = path.resolve(options.dataDir);
	if (options.host && Object.keys(options.agentPaths ?? {}).length > 0) {
		// The app keeps provider settings in memory; a file write would be lost.
		throw new CueBundleImportError(
			'INVALID_OPTIONS',
			'Binary paths cannot be set by an import into the running app. Set them in Settings.'
		);
	}
	for (const [toolType, binary] of Object.entries(options.agentPaths ?? {})) {
		if (!isValidAgentId(toolType)) {
			throw new CueBundleImportError(
				'INVALID_OPTIONS',
				`Unknown agent type "${toolType}" for a binary path`,
				{ toolType }
			);
		}
		if (!binary || !path.isAbsolute(binary)) {
			throw new CueBundleImportError(
				'INVALID_OPTIONS',
				`The binary path for ${toolType} must be an absolute path: ${binary}`,
				{ toolType }
			);
		}
	}
	const env = options.env ?? process.env;
	const warnings: string[] = [];

	// ─── Bundle ──────────────────────────────────────────────────────────────
	let archive: CueBundleArchive;
	try {
		archive = readCueBundleArchive(options.bundlePath);
	} catch (error) {
		throw new CueBundleImportError(
			'BUNDLE_UNREADABLE',
			`Could not read bundle: ${error instanceof Error ? error.message : String(error)}`,
			{ bundlePath: options.bundlePath }
		);
	}
	const validation = validateCueBundleArchive(archive, { runningVersion: options.runningVersion });
	if (!validation.valid || !validation.manifest) {
		throw new CueBundleImportError(
			'BUNDLE_INVALID',
			`The bundle is not valid: ${formatIssues(validation.errors)}`,
			{ errors: validation.errors, warnings: validation.warnings }
		);
	}
	const manifest: CueBundleManifest = validation.manifest;
	const entries = archive.entries;
	warnings.push(...(manifest.warnings ?? []), ...validation.warnings.map((w) => w.message));

	let layoutEntry: CuePipeline | undefined;
	const layoutBytes = entries.get(CUE_BUNDLE_LAYOUT_PATH);
	if (layoutBytes) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(layoutBytes.toString('utf-8'));
		} catch {
			parsed = undefined;
		}
		const checked = validatePipelineEntry(parsed);
		if (!checked.ok) {
			throw new CueBundleImportError(
				'BUNDLE_INVALID',
				`The bundle's pipeline layout is not valid: ${checked.message}`,
				{
					errors: [
						{ code: 'layout-invalid', message: checked.message, file: CUE_BUNDLE_LAYOUT_PATH },
					],
				}
			);
		}
		layoutEntry = checked.pipeline;
	}

	// ─── Data directory ──────────────────────────────────────────────────────
	const createDataDir = !fs.existsSync(dataDir);
	if (!createDataDir && !options.host) {
		assertDataDirIdle(dataDir, log);
		const syncPath = readJsonObject(path.join(dataDir, 'maestro-bootstrap.json'))?.customSyncPath;
		if (typeof syncPath === 'string' && syncPath) {
			throw new CueBundleImportError(
				'SYNC_PATH_REDIRECT',
				`${dataDir} keeps its agents in a custom sync folder (${syncPath}), which the desktop reads instead of the data directory. Import into that setup is not supported.`,
				{ customSyncPath: syncPath }
			);
		}
	}

	let sessionsData: SessionsStoreData = {};
	let existingSessions: SessionInfo[];
	if (options.host) {
		existingSessions = options.host.sessions;
	} else {
		try {
			const file = readSessionsStoreFile(dataDir);
			sessionsData = file.data ?? {};
			existingSessions = file.sessions;
		} catch (error) {
			if (error instanceof SessionsStoreCorruptError) {
				throw new CueBundleImportError('STORE_CORRUPT', error.message, { path: error.filePath });
			}
			throw error;
		}
	}
	const sessionsBefore = options.host
		? null
		: readIfExists(path.join(dataDir, 'maestro-sessions.json'));

	// ─── Workspaces ──────────────────────────────────────────────────────────
	const unmapped = manifest.workspaces.filter((ws) => !options.workspaces[ws.key]);
	if (unmapped.length > 0) {
		throw new CueBundleImportError(
			'WORKSPACE_UNMAPPED',
			`No local folder given for workspace${unmapped.length === 1 ? '' : 's'} ${unmapped.map((w) => `"${w.key}"`).join(', ')}`,
			{ workspaces: unmapped.map((w) => w.key) }
		);
	}
	const roots = new Map<string, string>();
	const missing: Array<{ key: string; path: string; gitRemote?: string; gitRef?: string }> = [];
	for (const ws of manifest.workspaces) {
		const mapped = options.workspaces[ws.key];
		if (!path.isAbsolute(mapped)) {
			throw new CueBundleImportError(
				'INVALID_OPTIONS',
				`The folder for workspace "${ws.key}" must be an absolute path: ${mapped}`,
				{ workspace: ws.key }
			);
		}
		const root = path.resolve(mapped);
		if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
			missing.push({
				key: ws.key,
				path: root,
				gitRemote: ws.source?.gitRemote,
				gitRef: ws.source?.gitRef,
			});
			continue;
		}
		roots.set(ws.key, root);
	}
	if (missing.length > 0) {
		const lines = missing.map((m) => {
			const clone = m.gitRemote
				? ` (clone ${m.gitRemote}${m.gitRef ? ` at ${m.gitRef}` : ''})`
				: '';
			return `"${m.key}" -> ${m.path}${clone}`;
		});
		throw new CueBundleImportError(
			'WORKSPACE_NOT_FOUND',
			`Workspace folder${missing.length === 1 ? ' does' : 's do'} not exist: ${lines.join('; ')}`,
			{ workspaces: missing }
		);
	}
	for (const key of Object.keys(options.workspaces)) {
		if (!manifest.workspaces.some((ws) => ws.key === key)) {
			warnings.push(`Workspace "${key}" is not in this bundle; its mapping was ignored.`);
		}
	}

	const conflicts: CueBundleImportConflict[] = [];
	const writes: PlannedWrite[] = [];
	const files: CueBundleImportFile[] = [];
	const plannedTargets = new Set<string>();

	const planFile = (
		kind: CueBundleImportFileKind,
		source: string,
		target: string,
		bytes: Buffer,
		executable = false
	) => {
		const before = fileBefore(target);
		let action: CueBundleImportFile['action'] = 'create';
		if (before) {
			if (before.equals(bytes)) action = 'unchanged';
			else {
				action = 'overwrite';
				conflicts.push({
					kind: kind === 'playbooks' ? 'playbooks' : 'file',
					target,
					message:
						kind === 'playbooks'
							? `Playbooks already saved at ${target} differ from the bundle's`
							: `${target} already exists with different content`,
				});
			}
		}
		files.push({ kind, source, target, action });
		plannedTargets.add(target);
		// Same bytes but missing its executable bit still needs the write's chmod.
		// Windows reports no executable bits on any file, so there is nothing to fix there.
		const lacksExec =
			executable && before !== null && !isWindows() && (fs.statSync(target).mode & 0o111) === 0;
		if (action !== 'unchanged' || lacksExec) {
			writes.push({
				target,
				content: bytes,
				before,
				via: 'file',
				...(executable ? { executable } : {}),
			});
		}
	};

	/**
	 * A workspace `.mcp.json` is merged, not replaced: the bundle's servers are
	 * added to the ones already there, and a same-named server that differs is
	 * a conflict.
	 */
	const planMcpConfig = (source: string, target: string, bytes: Buffer) => {
		const before = fileBefore(target);
		let content: string;
		let action: CueBundleImportFile['action'];
		try {
			const merged = mergeMcpConfig(before?.toString('utf-8'), bytes.toString('utf-8'));
			content = merged.content;
			action = !before ? 'create' : merged.unchanged ? 'unchanged' : 'overwrite';
			if (merged.replaced.length > 0) {
				conflicts.push({
					kind: 'file',
					target,
					message: `${target} already defines MCP server${merged.replaced.length === 1 ? '' : 's'} ${merged.replaced.map((n) => `"${n}"`).join(', ')} differently`,
				});
			}
		} catch (error) {
			content = bytes.toString('utf-8');
			action = 'overwrite';
			conflicts.push({
				kind: 'file',
				target,
				message: `${target} cannot be merged (${error instanceof Error ? error.message : String(error)}); force replaces it`,
			});
		}
		files.push({ kind: 'workspace', source, target, action });
		plannedTargets.add(target);
		if (action !== 'unchanged') writes.push({ target, content, before, via: 'file' });
	};
	const claudeConfigDir = options.claudeConfigDir ?? resolveClaudeConfigDir(options.env);
	/** `${VAR}` names the bundle's `.mcp.json` files reference, with who reads them. */
	const mcpSecrets: Array<[string, string]> = [];

	// ─── Agents ──────────────────────────────────────────────────────────────
	const settingsFile = readJsonObject(path.join(dataDir, 'maestro-settings.json')) ?? {};
	const saveToHistory =
		typeof settingsFile.defaultSaveToHistory === 'boolean'
			? settingsFile.defaultSaveToHistory
			: (getSettingDefault('defaultSaveToHistory') as boolean);
	const showThinking = (
		typeof settingsFile.defaultShowThinking === 'string'
			? settingsFile.defaultShowThinking
			: getSettingDefault('defaultShowThinking')
	) as ThinkingMode;

	const agents: CueBundleImportAgent[] = [];
	const envReports: CueBundleImportEnvReport[] = [];
	const unknownTypes: string[] = [];
	const nameTaken: string[] = [];
	const nextSessions = [...existingSessions] as Array<SessionInfo & Record<string, unknown>>;
	const bundleAgentIds = new Set(manifest.agents.map((a) => a.id));
	const autoRunFolders = new Map<string, string>();
	/**
	 * Workspace key -> secrets its bundled `.mcp.json` references. Read from the
	 * file itself, not only from the agents' `env.required`, so a bundle
	 * exported before the exporter listed them there still gives them to its
	 * Claude agents.
	 */
	const mcpSecretsByWorkspace = new Map<string, string[]>();
	for (const ws of manifest.workspaces) {
		const source = `workspaces/${ws.key}/${MCP_CONFIG_FILE}`;
		const bytes = manifest.files.some((f) => f.path === source) ? entries.get(source) : undefined;
		if (bytes) {
			mcpSecretsByWorkspace.set(
				ws.key,
				mcpConfigSecretNames(bytes.toString('utf-8'), manifest.requirements.secrets)
			);
		}
	}

	for (const agent of manifest.agents) {
		const settings = JSON.parse(
			entries.get(agent.settings)!.toString('utf-8')
		) as CueBundleAgentSettings;
		if (!isValidAgentId(settings.toolType)) {
			unknownTypes.push(`"${settings.name}" (${settings.toolType})`);
			continue;
		}
		const root = roots.get(settings.workspace)!;
		const cwd = settings.cwd
			? containedTarget(root, settings.cwd, `Agent "${settings.name}" working directory`)
			: realpathOrResolve(root);
		if (!fs.existsSync(cwd)) {
			warnings.push(`Agent "${settings.name}" works in ${cwd}, which does not exist yet.`);
		}

		let autoRunFolderPath: string | undefined;
		if (settings.autoRun && 'workspace' in settings.autoRun) {
			const autoRoot = roots.get(settings.autoRun.workspace) ?? root;
			autoRunFolderPath = settings.autoRun.path
				? containedTarget(
						autoRoot,
						settings.autoRun.path,
						`Agent "${settings.name}" Auto Run folder`
					)
				: realpathOrResolve(autoRoot);
		} else if (settings.autoRun && 'bundlePath' in settings.autoRun) {
			autoRunFolderPath = containedTarget(
				dataDir,
				`autorun/${agent.id}`,
				`Agent "${settings.name}" Auto Run folder`
			);
		}
		if (autoRunFolderPath) autoRunFolders.set(agent.id, autoRunFolderPath);

		const sanitized = sanitizeCustomEnvVars(settings.env?.values);
		envReports.push({
			agentId: agent.id,
			agentName: settings.name,
			kept: Object.keys(sanitized.sanitized).sort(),
			dropped: sanitized.droppedNames,
			machineSpecific: settings.env?.machineSpecific ?? [],
		});
		if (sanitized.droppedNames.length > 0) {
			warnings.push(
				`Agent "${settings.name}": dropped environment variable${sanitized.droppedNames.length === 1 ? '' : 's'} ${sanitized.droppedNames.join(', ')} (invalid name or blocked).`
			);
		}
		const customEnvVars =
			Object.keys(sanitized.sanitized).length > 0 ? sanitized.sanitized : undefined;

		// The workspace root is the agent's project root even when it works in a
		// subfolder, the way the desktop records an agent created in a project.
		const projectRoot = realpathOrResolve(root);
		const bundleFields = {
			name: settings.name,
			toolType: settings.toolType,
			cwd,
			fullPath: cwd,
			projectRoot,
			shellCwd: cwd,
			autoRunFolderPath: autoRunFolderPath ?? `${projectRoot}/${PLAYBOOKS_DIR}`,
			customModel: settings.customModel,
			customEffort: settings.customEffort,
			customArgs: settings.customArgs,
			customContextWindow: settings.customContextWindow,
			newSessionMessage: settings.newSessionMessage,
			nudgeMessage: settings.nudgeMessage,
			enableMaestroP: settings.enableMaestroP,
			maestroPMode: settings.maestroPMode,
			customEnvVars,
			// Names only. The CLI and Cue resolve them at launch from systemd
			// credentials, /run/secrets or the environment, for this agent alone.
			// A Claude agent also needs what its workspace's `.mcp.json` expands;
			// no other provider reads that file.
			requiredSecrets: requiredSecretNames([
				...asStringList(settings.env?.required),
				...(settings.toolType === 'claude-code'
					? (mcpSecretsByWorkspace.get(settings.workspace) ?? [])
					: []),
			]),
		} satisfies Record<(typeof CUE_BUNDLE_AGENT_FIELDS)[number], unknown>;
		const sameName = existingSessions.find(
			(s) => s.id !== agent.id && s.name.toLowerCase() === settings.name.toLowerCase()
		);
		if (sameName) {
			nameTaken.push(`"${settings.name}" (existing agent ${sameName.id})`);
			continue;
		}

		const existingIndex = nextSessions.findIndex((s) => s.id === agent.id);
		if (existingIndex >= 0) {
			conflicts.push({
				kind: 'agent',
				target: agent.id,
				message: `Agent ${agent.id} ("${nextSessions[existingIndex].name}") already exists`,
			});
			nextSessions[existingIndex] = { ...nextSessions[existingIndex], ...bundleFields };
		} else {
			nextSessions.push({
				...buildNewAgentRecord(
					{
						id: agent.id,
						name: settings.name,
						toolType: settings.toolType,
						cwd,
						autoRunFolderPath: bundleFields.autoRunFolderPath,
						saveToHistory,
						showThinking,
					},
					{ generateId: generateUUID }
				),
				...bundleFields,
				claudeInteractive: newAgentClaudeInteractive(settings.toolType),
			} as SessionInfo & Record<string, unknown>);
		}
		agents.push({
			id: agent.id,
			name: settings.name,
			toolType: settings.toolType,
			workspace: settings.workspace,
			cwd,
			action: existingIndex >= 0 ? 'update' : 'create',
		});
		for (const name of settings.env?.machineSpecific ?? []) {
			warnings.push(
				`Agent "${settings.name}" needs ${name} set to a local path; set it after import.`
			);
		}
	}
	if (unknownTypes.length > 0) {
		throw new CueBundleImportError(
			'UNKNOWN_AGENT_TYPE',
			`This build does not know the provider of ${unknownTypes.join(', ')}`,
			{ agents: unknownTypes }
		);
	}
	if (nameTaken.length > 0) {
		throw new CueBundleImportError(
			'AGENT_NAME_TAKEN',
			`Another agent already uses the name ${nameTaken.join(', ')}. Rename it before importing.`,
			{ agents: nameTaken }
		);
	}

	// ─── Files: workspace content, out-of-workspace Auto Run, playbooks ──────
	const cueConfigPaths = new Set(
		manifest.workspaces.flatMap((ws) => (ws.cueConfig ? [ws.cueConfig] : []))
	);
	const agentByPlaybooks = new Map(
		manifest.agents.flatMap((a) => (a.playbooks ? [[a.playbooks, a.id]] : []))
	);
	const settingsPaths = new Set(manifest.agents.map((a) => a.settings));
	for (const entry of manifest.files) {
		const source = entry.path;
		const bytes = entries.get(source)!;
		if (
			source === CUE_BUNDLE_README_PATH ||
			source === CUE_BUNDLE_MANIFEST_PATH ||
			source === CUE_BUNDLE_LAYOUT_PATH ||
			settingsPaths.has(source) ||
			cueConfigPaths.has(source)
		) {
			continue;
		}
		const playbooksOf = agentByPlaybooks.get(source);
		if (playbooksOf) {
			const target = containedTarget(
				dataDir,
				`playbooks/${playbooksOf}.json`,
				`Playbooks for agent ${playbooksOf}`
			);
			planFile('playbooks', source, target, bytes);
			continue;
		}
		const ws = /^workspaces\/([^/]+)\/(.+)$/.exec(source);
		if (ws && roots.has(ws[1]) && ws[2] === MCP_CONFIG_FILE) {
			const target = containedTarget(roots.get(ws[1])!, ws[2], source);
			planMcpConfig(source, target, bytes);
			for (const name of mcpSecretsByWorkspace.get(ws[1]) ?? []) {
				mcpSecrets.push([name, `mcp:${ws[1]}`]);
			}
			continue;
		}
		if (ws && roots.has(ws[1])) {
			planFile(
				'workspace',
				source,
				containedTarget(roots.get(ws[1])!, ws[2], source),
				bytes,
				entry.executable === true
			);
			continue;
		}
		const memory = new RegExp(`^${CUE_BUNDLE_CLAUDE_MEMORY_DIR}/([^/]+)/([^/]+)$`).exec(source);
		if (memory && roots.has(memory[1]) && isClaudeMemoryFileName(memory[2])) {
			const dir = claudeMemoryDir(claudeConfigDir, realpathOrResolve(roots.get(memory[1])!));
			planFile('claude-memory', source, containedTarget(dir, memory[2], source), bytes);
			continue;
		}
		const auto = /^autorun\/([^/]+)\/(.+)$/.exec(source);
		if (auto && bundleAgentIds.has(auto[1])) {
			planFile(
				'autorun',
				source,
				containedTarget(dataDir, `autorun/${auto[1]}/${auto[2]}`, source),
				bytes
			);
			continue;
		}
		warnings.push(`${source} has no place on this machine and was not imported.`);
	}

	// ─── cue.yaml merges ─────────────────────────────────────────────────────
	const shellCommands: CueBundleImportShellCommand[] = [];
	const cueConfigs: CueBundleImportCueConfig[] = [];
	const secretUsers = new Map<string, Set<string>>();
	const agentSecretNames = new Set<string>();
	const addSecretUser = (name: string, user: string) => {
		if (!secretUsers.has(name)) secretUsers.set(name, new Set());
		secretUsers.get(name)!.add(user);
	};
	for (const agent of manifest.agents) {
		const settings = JSON.parse(
			entries.get(agent.settings)!.toString('utf-8')
		) as CueBundleAgentSettings;
		for (const name of asStringList(settings.env?.required)) {
			addSecretUser(name, `agent:${settings.name}`);
			agentSecretNames.add(name);
		}
	}
	const knownAgentRefs = new Set<string>([
		...nextSessions.map((s) => s.id),
		...nextSessions.map((s) => s.name),
	]);

	for (const ws of manifest.workspaces) {
		if (!ws.cueConfig) continue;
		const root = roots.get(ws.key)!;
		const doc = yaml.load(entries.get(ws.cueConfig)!.toString('utf-8')) as Record<string, unknown>;
		const subs = (Array.isArray(doc.subscriptions) ? doc.subscriptions : []).filter(isRecord);

		for (const sub of subs) {
			const name = typeof sub.name === 'string' ? sub.name : '(unnamed)';
			const command = isRecord(sub.command) ? sub.command : undefined;
			if (command?.mode === 'shell') {
				shellCommands.push({
					workspace: ws.key,
					subscription: name,
					command: String(command.shell ?? ''),
				});
			}
			const secretEnv = isRecord(sub.webhook) ? sub.webhook.secret_env : undefined;
			if (typeof secretEnv === 'string' && secretEnv) addSecretUser(secretEnv, `webhook:${name}`);
			for (const field of ['source_session', 'source_session_ids', 'fan_out_ids'] as const) {
				for (const ref of asStringList(sub[field])) {
					if (!knownAgentRefs.has(ref)) {
						warnings.push(
							`Subscription "${name}" refers to agent "${ref}" (${field}), which does not exist here.`
						);
					}
				}
			}
		}

		const canonical = containedTarget(root, CUE_CONFIG_PATH, `cue.yaml for workspace "${ws.key}"`);
		const existingPath = resolveCueConfigPath(realpathOrResolve(root));
		const legacy = existingPath && existingPath !== canonical ? existingPath : undefined;
		const raw = existingPath ? fs.readFileSync(existingPath, 'utf-8') : null;

		// A subscription already present with identical content is not a conflict:
		// re-importing the same bundle leaves it where it is.
		let existingSubs: Record<string, unknown>[] = [];
		if (raw !== null) {
			let loaded: unknown;
			try {
				loaded = yaml.load(raw);
			} catch (error) {
				throw new CueBundleImportError(
					'CUE_CONFIG_INVALID',
					`${existingPath} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
					{ path: existingPath }
				);
			}
			if (isRecord(loaded) && Array.isArray(loaded.subscriptions)) {
				existingSubs = loaded.subscriptions.filter(isRecord);
			}
		}
		const existingByName = new Map(existingSubs.map((s) => [s.name, s]));
		const unchanged: string[] = [];
		const toMerge = subs.filter((sub) => {
			const current = existingByName.get(sub.name);
			if (current && JSON.stringify(current) === JSON.stringify(sub)) {
				unchanged.push(String(sub.name));
				return false;
			}
			return true;
		});

		const merge = mergeSubscriptionsIntoCueYaml(raw, toMerge, {
			replaceExisting: true,
			settings: isRecord(doc.settings) ? doc.settings : undefined,
		});
		for (const name of merge.replaced) {
			conflicts.push({
				kind: 'subscription',
				target: name,
				message: `Subscription "${name}" already exists in ${existingPath ?? canonical} with different content`,
			});
		}
		for (const key of merge.settingsKept) {
			warnings.push(
				`Workspace "${ws.key}": kept the local cue.yaml settings.${key}, which differs from the bundle's.`
			);
		}
		cueConfigs.push({
			workspace: ws.key,
			path: canonical,
			created: raw === null,
			added: merge.added,
			replaced: merge.replaced,
			unchanged,
			settingsKept: merge.settingsKept,
			...(legacy ? { legacyRemoved: legacy } : {}),
		});
		if (plannedTargets.has(canonical)) {
			throw new CueBundleImportError(
				'BUNDLE_INVALID',
				`${canonical} is both a bundle file and a merged cue.yaml`
			);
		}
		// Nothing to add: leave the file alone rather than rewrite it, since a
		// rewrite drops every comment below its header.
		const changes =
			raw === null ||
			merge.added.length > 0 ||
			merge.replaced.length > 0 ||
			merge.settingsAdded.length > 0 ||
			!!legacy;
		if (changes) {
			writes.push({
				target: canonical,
				content: merge.content,
				before: fileBefore(canonical),
				via: 'cue-yaml',
			});
		}
		if (legacy)
			writes.push({ target: legacy, content: null, before: fileBefore(legacy), via: 'file' });
	}

	if (options.refuseShellCommands && shellCommands.length > 0) {
		throw new CueBundleImportError(
			'SHELL_COMMANDS_REFUSED',
			`The bundle runs ${shellCommands.length} shell command${shellCommands.length === 1 ? '' : 's'}: ${shellCommands.map((c) => `"${c.subscription}"`).join(', ')}`,
			{ shellCommands }
		);
	}

	// ─── Pipeline layout ─────────────────────────────────────────────────────
	let pipeline: CueBundleImportPlan['pipeline'];
	let layout: PipelineLayoutState | undefined;
	if (layoutEntry) {
		const layoutPath = containedTarget(dataDir, 'cue-pipeline-layout.json', 'Pipeline layout');
		const layoutBefore = fileBefore(layoutPath);
		const current = layoutBefore ? loadPipelineLayout(dataDir) : null;
		if (layoutBefore && !current) {
			throw new CueBundleImportError('STORE_CORRUPT', `Could not read ${layoutPath}`, {
				path: layoutPath,
			});
		}
		const base: PipelineLayoutState = current ?? {
			version: 2,
			pipelines: [],
			selectedPipelineId: layoutEntry.id,
			perProject: {},
		};
		const existing = base.pipelines.find(
			(p) => p.id === layoutEntry!.id || p.name === layoutEntry!.name
		);
		if (existing && JSON.stringify(existing) === JSON.stringify(layoutEntry)) {
			pipeline = { id: layoutEntry.id, name: layoutEntry.name, action: 'unchanged' };
		} else {
			if (existing) {
				conflicts.push({
					kind: 'pipeline',
					target: layoutEntry.name,
					message: `Pipeline "${existing.name}" already has a saved layout`,
				});
			}
			const result = upsertPipeline(base, layoutEntry, existing ? 'replace' : 'add');
			if (!result.ok) throw new CueBundleImportError('CONFLICTS', result.message);
			layout = result.layout;
			pipeline = {
				id: layoutEntry.id,
				name: layoutEntry.name,
				action: existing ? 'overwrite' : 'create',
			};
			writes.push({ target: layoutPath, content: null, before: layoutBefore, via: 'layout' });
		}
	}

	// ─── Provider binary paths ───────────────────────────────────────────────
	const agentPaths: CueBundleImportAgentPath[] = [];
	let agentConfigsData: AgentConfigsStoreData | undefined;
	const requestedPaths = Object.entries(options.agentPaths ?? {}).sort(([a], [b]) =>
		a.localeCompare(b)
	);
	if (requestedPaths.length > 0) {
		let current: ReturnType<typeof readAgentConfigsStoreFile>;
		try {
			current = readAgentConfigsStoreFile(dataDir);
		} catch (error) {
			if (error instanceof AgentConfigsStoreCorruptError) {
				throw new CueBundleImportError('STORE_CORRUPT', error.message, { path: error.filePath });
			}
			throw error;
		}
		const configs = { ...current.configs };
		const usedTools = new Set(agents.map((a) => a.toolType));
		for (const [toolType, binary] of requestedPaths) {
			if (!usedTools.has(toolType)) {
				warnings.push(`No agent in this bundle runs ${toolType}; its binary path is set anyway.`);
			}
			try {
				fs.accessSync(binary, fs.constants.X_OK);
			} catch {
				warnings.push(`${binary} (for ${toolType}) is missing or not executable yet.`);
			}
			const previous = configs[toolType]?.customPath;
			const prev = typeof previous === 'string' && previous ? previous : undefined;
			if (prev === binary) {
				agentPaths.push({ toolType, path: binary, action: 'unchanged', previous: prev });
				continue;
			}
			if (prev) {
				conflicts.push({
					kind: 'agent-path',
					target: toolType,
					message: `${toolType} already runs ${prev}`,
				});
			}
			agentPaths.push({
				toolType,
				path: binary,
				action: prev ? 'overwrite' : 'create',
				...(prev ? { previous: prev } : {}),
			});
			configs[toolType] = { ...configs[toolType], customPath: binary };
		}
		if (agentPaths.some((p) => p.action !== 'unchanged')) {
			agentConfigsData = { ...current.data, configs };
			const target = agentConfigsStorePath(dataDir);
			writes.push({ target, content: null, before: fileBefore(target), via: 'agent-configs' });
		}
	}

	// ─── Secrets ─────────────────────────────────────────────────────────────
	// Claude expands these from its own environment, so on a server they are
	// subject to the inherited-env allowlist like an agent's own secrets.
	for (const [name, user] of mcpSecrets) {
		addSecretUser(name, user);
		agentSecretNames.add(name);
	}
	for (const name of manifest.requirements.secrets) {
		if (!secretUsers.has(name)) secretUsers.set(name, new Set());
	}
	const secrets: CueBundleImportSecret[] = [...secretUsers.keys()].sort().map((name) => {
		// The same lookup the engine and the CLI make at launch, so a secret
		// supplied only as a file is not reported missing. The value is dropped.
		const lookup = lookupSecret(name, { env, runSecretsDir: options.runSecretsDir });
		const secret: CueBundleImportSecret = {
			name,
			set: lookup.status === 'found',
			usedBy: [...secretUsers.get(name)!].sort(),
		};
		if (lookup.status === 'found') secret.source = lookup.source;
		if (lookup.status === 'unusable') {
			secret.problem = describeSecretProblem({ name, ...lookup });
		}
		if (agentSecretNames.has(name)) {
			secret.passesServerAllowlist =
				Object.keys(filterServerProcessEnv({ [name]: 'x' })).length > 0;
		}
		return secret;
	});

	const plan: CueBundleImportPlan = {
		bundle: {
			name: manifest.name,
			kind: manifest.kind,
			producerVersion: manifest.producer.version,
		},
		dataDir,
		createDataDir,
		agents,
		files,
		cueConfigs,
		...(pipeline ? { pipeline } : {}),
		agentPaths,
		shellCommands,
		env: envReports,
		secrets,
		conflicts,
		warnings: [...new Set(warnings)],
	};
	return {
		plan,
		writes,
		layout,
		agentConfigsData,
		sessionsData: { ...sessionsData, sessions: nextSessions },
		sessionsBefore,
	};
}

/**
 * Check a bundle against a target and report everything an import would do,
 * including conflicts. Writes nothing. Throws {@link CueBundleImportError} for
 * every refusal except conflicts, which are listed in the plan.
 */
export async function planCueBundleImport(
	options: CueBundleImportOptions
): Promise<CueBundleImportPlan> {
	return (await buildPlan(options)).plan;
}

// ─── Apply ──────────────────────────────────────────────────────────────────

/** mkdir -p that remembers which directories it created, deepest last. */
function ensureDir(dir: string, created: string[]): void {
	const missing: string[] = [];
	let current = path.resolve(dir);
	while (!fs.existsSync(current)) {
		missing.unshift(current);
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	for (const d of missing) {
		fs.mkdirSync(d);
		created.push(d);
	}
}

async function restore(write: PlannedWrite): Promise<void> {
	if (write.before) {
		fs.mkdirSync(path.dirname(write.target), { recursive: true });
		await atomicWriteFile(write.target, write.before);
	} else {
		fs.rmSync(write.target, { force: true });
	}
}

/**
 * Import a bundle: plan it, refuse on any problem (conflicts too, unless
 * `force`), then write. A dry run returns the plan and writes nothing.
 */
export async function importCueBundle(
	options: CueBundleImportOptions
): Promise<CueBundleImportResult> {
	const log = options.onLog ?? (() => {});
	const internal = await buildPlan(options);
	const { plan } = internal;
	if (options.dryRun) return { plan, applied: false };

	if (plan.conflicts.length > 0 && !options.force) {
		throw new CueBundleImportError(
			'CONFLICTS',
			`The import conflicts with existing data in ${plan.conflicts.length} place${plan.conflicts.length === 1 ? '' : 's'}. Pass force to overwrite.`,
			{ conflicts: plan.conflicts }
		);
	}

	// The plan may be minutes old by now (a CLI prompt, a slow disk): look again
	// right before the first write.
	if (fs.existsSync(plan.dataDir) && !options.host) assertDataDirIdle(plan.dataDir, log);
	await options.onBeforeWrite?.(plan);

	const createdDirs: string[] = [];
	const done: PlannedWrite[] = [];
	const sessionsWrite: PlannedWrite = {
		target: path.join(plan.dataDir, 'maestro-sessions.json'),
		content: null,
		before: internal.sessionsBefore,
		via: 'file',
	};
	try {
		if (plan.createDataDir) {
			ensureDir(plan.dataDir, createdDirs);
			log('info', `Created the data directory ${plan.dataDir}.`);
		}
		for (const write of internal.writes) {
			done.push(write);
			if (write.content === null && write.via === 'file') {
				fs.rmSync(write.target, { force: true });
				continue;
			}
			ensureDir(path.dirname(write.target), createdDirs);
			if (write.via === 'cue-yaml') writeCueYamlAtomicSync(write.target, String(write.content));
			else if (write.via === 'layout') savePipelineLayout(internal.layout!, plan.dataDir);
			else if (write.via === 'agent-configs') {
				await writeAgentConfigsStoreFile(plan.dataDir, internal.agentConfigsData!);
			} else {
				await atomicWriteFile(write.target, write.content as Buffer);
				if (write.executable) fs.chmodSync(write.target, 0o755);
			}
		}
		// Agents last: until this write lands, nothing points at the files above.
		if (options.host) {
			const byId = new Map((internal.sessionsData.sessions ?? []).map((s) => [s.id, s]));
			const pick = (action: CueBundleImportAgent['action']) =>
				plan.agents.filter((a) => a.action === action).map((a) => byId.get(a.id)!);
			await options.host.applyAgents({ created: pick('create'), updated: pick('update') });
		} else {
			done.push(sessionsWrite);
			await writeSessionsStoreFile(plan.dataDir, internal.sessionsData);
		}
	} catch (error) {
		const failures: string[] = [];
		for (const write of done.reverse()) {
			try {
				await restore(write);
			} catch (restoreError) {
				failures.push(
					`${write.target}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
				);
			}
		}
		for (const dir of createdDirs.reverse()) {
			try {
				fs.rmdirSync(dir);
			} catch {
				// Not empty (a restore failed above) or already gone; leave it.
			}
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new CueBundleImportError(
			'WRITE_FAILED',
			failures.length === 0
				? `Import failed and was rolled back: ${message}`
				: `Import failed and could not be fully rolled back: ${message}. Not restored: ${failures.join('; ')}`,
			{ rolledBack: failures.length === 0, notRestored: failures }
		);
	}

	for (const agent of plan.agents) {
		log(
			'info',
			`${agent.action === 'create' ? 'Imported' : 'Updated'} agent "${agent.name}" (${agent.id}).`
		);
	}
	return { plan, applied: true };
}
