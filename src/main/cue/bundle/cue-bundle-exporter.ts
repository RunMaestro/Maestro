/**
 * Cue bundle exporter - packs one visual pipeline (or one agent) into a
 * portable, deterministic zip described by `src/shared/cue-bundle-types.ts`.
 *
 * It reads Maestro's state straight off disk from an explicit `dataDir`, so it
 * runs with the desktop app closed, and it never imports Electron: the CLI
 * loads it through a dynamic `import()` (`src/cli/commands/bundle.ts`), and
 * the engine-coupling ratchet (`cue-electron-imports.test.ts`) covers this
 * folder too.
 *
 * Three guarantees, each enforced here rather than trusted to the caller:
 *
 * 1. **No secret values.** Agent env vars that look secret travel by NAME only
 *    (`env.required`), as do values shaped like a known credential (`sk-`,
 *    `ghp_`, ...) whatever their name, parked vars (`customEnvVarsDisabled`) never travel, and a
 *    literal `webhook.secret` refuses the export unless explicitly allowed.
 * 2. **No local paths.** Every absolute path is replaced by a workspace key plus
 *    a relative path, git remotes lose their userinfo, and a final guard scans
 *    every generated file for a known local root before anything is written.
 * 3. **Byte-identical output.** Entries are sorted, every entry carries the same
 *    fixed date, and `createdAt` is omitted unless the caller pins it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import archiver from 'archiver';
import * as yaml from 'js-yaml';
import type { Playbook, SessionInfo } from '../../../shared/types';
import type { CuePipeline, PipelineLayoutState } from '../../../shared/cue-pipeline-types';
import { CUE_CONFIG_PATH } from '../../../shared/maestro-paths';
import { effectiveAgentCustomEnvVars } from '../../../shared/providerProfiles';
import { isSecretEnvKey } from '../../../shared/agentEnvironment';
import {
	CUE_BUNDLE_LAYOUT_PATH,
	CUE_BUNDLE_MANIFEST_PATH,
	CUE_BUNDLE_MIN_ENGINE_VERSION,
	CUE_BUNDLE_README_PATH,
	CUE_BUNDLE_VERSION,
	type CueBundleAgent,
	type CueBundleAgentSettings,
	type CueBundleFileEntry,
	type CueBundleKind,
	type CueBundleManifest,
	type CueBundleRequirements,
	type CueBundleWorkspace,
	type CueBundleWorkspaceSource,
} from '../../../shared/cue-bundle-types';
import { resolveCueConfigPath } from '../config/cue-config-repository';

/** Every entry gets this date, so the archive bytes depend only on content. */
export const CUE_BUNDLE_FIXED_MTIME = new Date('2026-01-01T00:00:00Z');

export interface CueBundleExportOptions {
	/** Maestro's data directory (`maestro-sessions.json`, `playbooks/`, layout file). */
	dataDir: string;
	/** Export this pipeline (matched by name, then id). Exclusive with `agentId`. */
	pipeline?: string;
	/** Export this agent. The caller resolves a user-typed name to an id first. */
	agentId?: string;
	/** Where to write the zip. Parent directories are created. */
	outputPath: string;
	/** Permit a literal `webhook.secret` in an exported subscription. */
	allowInlineSecrets?: boolean;
	/** Pin `manifest.createdAt` (ISO-8601). Wins over `SOURCE_DATE_EPOCH`. */
	createdAt?: string;
	/** Version string recorded as `manifest.producer.version`. */
	producerVersion?: string;
	/** Environment consulted for `SOURCE_DATE_EPOCH`. Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
}

export interface CueBundleExportResult {
	outputPath: string;
	manifest: CueBundleManifest;
	/** Size of the written zip. */
	size: number;
	/** SHA-256 of the written zip. */
	sha256: string;
}

/** Raw (un-normalized) subscription as it sits in cue.yaml. */
type RawSubscription = Record<string, unknown>;

interface RawCueDocument {
	subscriptions?: unknown;
	settings?: Record<string, unknown>;
}

interface WorkspaceBuild {
	root: string;
	key: string;
	subscriptions: RawSubscription[];
	settings?: Record<string, unknown>;
	contributedConfig: boolean;
}

// ─── Small pure helpers ─────────────────────────────────────────────────────

function toPosix(p: string): string {
	return p.split(path.sep).join('/');
}

function sha256(data: Buffer | string): string {
	return crypto.createHash('sha256').update(data).digest('hex');
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug || 'workspace';
}

function asStringList(value: unknown): string[] {
	if (typeof value === 'string') return value ? [value] : [];
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && !!v);
	return [];
}

function sortedUnique(values: Iterable<string>): string[] {
	return [...new Set(values)].sort();
}

/**
 * True when `child` is `parent` or sits beneath it. Windows paths are compared
 * case-insensitively, since `C:\Proj` and `c:\proj` name the same folder there
 * and a case-sensitive check would call an Auto Run folder "outside" its root.
 */
export function isWithin(
	parent: string,
	child: string,
	platform: NodeJS.Platform = process.platform
): boolean {
	const p = platform === 'win32' ? path.win32 : path;
	const fold = (s: string) => (platform === 'win32' ? s.toLowerCase() : s);
	const rel = p.relative(fold(parent), fold(child));
	return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

/**
 * Value prefixes that mark a well-known credential (OpenAI/Anthropic `sk-`,
 * GitHub `ghp_` / `github_pat_`, Slack `xox*`). Catches a secret stored under
 * a name `isSecretEnvKey` does not recognize.
 */
const SECRET_VALUE_PREFIXES = ['sk-', 'ghp_', 'github_pat_', 'xox'];

function looksLikeSecretValue(value: unknown): boolean {
	return typeof value === 'string' && SECRET_VALUE_PREFIXES.some((p) => value.startsWith(p));
}

function readJsonFile<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw new Error(
			`Could not read ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

/**
 * Assign each project root a deterministic key: roots are sorted, then each
 * takes the slug of its folder name, with `-2`, `-3` on collision.
 */
export function assignWorkspaceKeys(roots: Iterable<string>): Map<string, string> {
	const keys = new Map<string, string>();
	const taken = new Set<string>();
	for (const root of sortedUnique(roots)) {
		const base = slugify(path.basename(root));
		let key = base;
		for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
		taken.add(key);
		keys.set(root, key);
	}
	return keys;
}

/**
 * Strip credentials from a git remote. `https://token@github.com/o/r` becomes
 * `https://github.com/o/r`; scp-style `git@host:o/r` is left alone, since `git`
 * there is a login name rather than a secret.
 */
export function scrubGitRemote(remote: string): string {
	const trimmed = remote.trim();
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
	try {
		const url = new URL(trimmed);
		if (/^https?:$/i.test(url.protocol)) url.username = '';
		url.password = '';
		url.search = '';
		url.hash = '';
		return url.toString();
	} catch {
		// Unparseable but scheme-shaped: drop anything that looks like userinfo.
		return trimmed.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
	}
}

// ─── Git source info (read from .git directly, no process spawn) ────────────

function resolveGitDirs(root: string): { gitDir: string; commonDir: string } | null {
	const dotGit = path.join(root, '.git');
	let stat: fs.Stats;
	try {
		stat = fs.statSync(dotGit);
	} catch {
		return null;
	}
	let gitDir = dotGit;
	if (stat.isFile()) {
		const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf-8'));
		if (!match) return null;
		gitDir = path.resolve(root, match[1].trim());
	}
	let commonDir = gitDir;
	try {
		const common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf-8').trim();
		if (common) commonDir = path.resolve(gitDir, common);
	} catch {
		// Not a linked worktree.
	}
	return { gitDir, commonDir };
}

function readGitSource(root: string): CueBundleWorkspaceSource | undefined {
	const dirs = resolveGitDirs(root);
	if (!dirs) return undefined;
	const source: CueBundleWorkspaceSource = {};
	try {
		const config = fs.readFileSync(path.join(dirs.commonDir, 'config'), 'utf-8');
		const section = /\[remote\s+"origin"\]([^[]*)/.exec(config);
		const url = section && /^\s*url\s*=\s*(.+)$/m.exec(section[1]);
		if (url) source.gitRemote = scrubGitRemote(url[1]);
	} catch {
		// No config, no remote.
	}
	let head: string | undefined;
	try {
		head = fs.readFileSync(path.join(dirs.gitDir, 'HEAD'), 'utf-8').trim();
	} catch {
		// Unreadable HEAD: no branch, no commit.
	}
	if (head) {
		const ref = /^ref:\s*(\S+)$/.exec(head);
		if (ref) {
			const branch = /^refs\/heads\/(.+)$/.exec(ref[1]);
			if (branch) source.gitBranch = branch[1];
			const sha = resolveGitRef(dirs, ref[1]);
			if (sha) source.gitRef = sha;
		} else if (GIT_SHA_RE.test(head)) {
			source.gitRef = head.toLowerCase();
		}
	}
	return source.gitRemote || source.gitBranch || source.gitRef ? source : undefined;
}

/** A full SHA-1 or SHA-256 object name. */
const GIT_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

/**
 * Resolve a symbolic ref (`refs/heads/main`) to its commit: the loose ref file
 * first (per-worktree dir, then the shared one), then `packed-refs`. Returns
 * undefined for an unborn branch.
 */
function resolveGitRef(
	dirs: { gitDir: string; commonDir: string },
	ref: string
): string | undefined {
	for (const dir of new Set([dirs.gitDir, dirs.commonDir])) {
		try {
			const value = fs.readFileSync(path.join(dir, ref), 'utf-8').trim();
			if (GIT_SHA_RE.test(value)) return value.toLowerCase();
		} catch {
			// Not a loose ref here.
		}
	}
	try {
		const packed = fs.readFileSync(path.join(dirs.commonDir, 'packed-refs'), 'utf-8');
		for (const line of packed.split(/\r?\n/)) {
			const [sha, name] = line.trim().split(/\s+/);
			if (name === ref && sha && GIT_SHA_RE.test(sha)) return sha.toLowerCase();
		}
	} catch {
		// No packed-refs.
	}
	return undefined;
}

// ─── Data loading ────────────────────────────────────────────────────────────

/** Agents from `maestro-sessions.json`, in stored order (Cue's ownership order). */
export function readSessions(dataDir: string): SessionInfo[] {
	const store = readJsonFile<{ sessions?: SessionInfo[] }>(
		path.join(dataDir, 'maestro-sessions.json')
	);
	return Array.isArray(store?.sessions) ? store.sessions : [];
}

function readProviderEnv(dataDir: string, toolType: string): Record<string, string> | undefined {
	const store = readJsonFile<{ configs?: Record<string, Record<string, unknown>> }>(
		path.join(dataDir, 'maestro-agent-configs.json')
	);
	const env = store?.configs?.[toolType]?.customEnvVars;
	return env && typeof env === 'object' ? (env as Record<string, string>) : undefined;
}

function readPlaybooks(dataDir: string, agentId: string): Playbook[] {
	const file = readJsonFile<{ playbooks?: Playbook[] }>(
		path.join(dataDir, 'playbooks', `${agentId}.json`)
	);
	return Array.isArray(file?.playbooks) ? file.playbooks : [];
}

function findPipeline(dataDir: string, identifier: string): CuePipeline | undefined {
	const layout = readJsonFile<PipelineLayoutState>(path.join(dataDir, 'cue-pipeline-layout.json'));
	const pipelines = Array.isArray(layout?.pipelines) ? layout.pipelines : [];
	return pipelines.find((p) => p.name === identifier) ?? pipelines.find((p) => p.id === identifier);
}

function readCueDocument(root: string): RawCueDocument | undefined {
	const configPath = resolveCueConfigPath(root);
	if (!configPath) return undefined;
	let parsed: unknown;
	try {
		parsed = yaml.load(fs.readFileSync(configPath, 'utf-8'));
	} catch (error) {
		throw new Error(
			`Could not parse the Cue config in workspace "${path.basename(root)}": ${error instanceof Error ? error.message : String(error)}`
		);
	}
	return parsed && typeof parsed === 'object' ? (parsed as RawCueDocument) : undefined;
}

function rawSubscriptions(doc: RawCueDocument | undefined): RawSubscription[] {
	if (!doc || !Array.isArray(doc.subscriptions)) return [];
	return doc.subscriptions.filter(
		(s): s is RawSubscription => !!s && typeof s === 'object' && !Array.isArray(s)
	);
}

function agentRoot(session: SessionInfo): string {
	return path.resolve(session.projectRoot || session.cwd);
}

// ─── Prompt-file containment ─────────────────────────────────────────────────

/**
 * Resolve a prompt file referenced from cue.yaml and prove it stays inside the
 * project root, following symlinks. Returns the root-relative POSIX path.
 */
function resolveContainedFile(root: string, ref: string, what: string): string {
	const realRoot = fs.realpathSync(root);
	const candidate = path.isAbsolute(ref) ? path.resolve(ref) : path.resolve(root, ref);
	if (!isWithin(path.resolve(root), candidate) && !isWithin(realRoot, candidate)) {
		throw new Error(`${what} "${ref}" escapes its project root`);
	}
	let real: string;
	try {
		real = fs.realpathSync(candidate);
	} catch {
		throw new Error(`${what} "${ref}" does not exist`);
	}
	if (!isWithin(realRoot, real)) {
		throw new Error(`${what} "${ref}" resolves through a symlink outside its project root`);
	}
	if (!fs.statSync(real).isFile()) {
		throw new Error(`${what} "${ref}" is not a file`);
	}
	return toPosix(path.relative(realRoot, real));
}

// ─── The exporter ────────────────────────────────────────────────────────────

class BundleBuilder {
	readonly files = new Map<string, Buffer>();
	readonly warnings = new Set<string>();

	add(archivePath: string, content: Buffer | string): void {
		const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
		const existing = this.files.get(archivePath);
		if (existing && !existing.equals(buf)) {
			throw new Error(`Two different files map to the same bundle path: ${archivePath}`);
		}
		this.files.set(archivePath, buf);
	}

	addJson(archivePath: string, value: unknown): void {
		this.add(archivePath, JSON.stringify(value, null, '\t') + '\n');
	}
}

function resolveCreatedAt(options: CueBundleExportOptions): string | undefined {
	if (options.createdAt) {
		const ms = Date.parse(options.createdAt);
		if (Number.isNaN(ms)) throw new Error(`Invalid --created-at value: ${options.createdAt}`);
		return new Date(ms).toISOString();
	}
	const epoch = (options.env ?? process.env).SOURCE_DATE_EPOCH;
	if (epoch !== undefined && epoch !== '') {
		const seconds = Number(epoch);
		if (!Number.isFinite(seconds)) throw new Error(`Invalid SOURCE_DATE_EPOCH: ${epoch}`);
		return new Date(seconds * 1000).toISOString();
	}
	return undefined;
}

/** Resolve `owner_agent_id`, which may hold an id or a display name, to an id. */
function resolveOwnerId(owner: unknown, sessions: SessionInfo[]): string | undefined {
	if (typeof owner !== 'string' || !owner) return undefined;
	if (sessions.some((s) => s.id === owner)) return owner;
	return sessions.find((s) => s.name === owner)?.id ?? owner;
}

/**
 * The agent an unassigned subscription runs on: `settings.owner_agent_id` when
 * set, else the first agent in `maestro-sessions.json` whose project root is
 * this one, which is the agent Cue picks at runtime (`computeOwnershipWarning`).
 */
function resolveUnownedTarget(
	owner: unknown,
	root: string,
	sessions: SessionInfo[]
): string | undefined {
	return resolveOwnerId(owner, sessions) ?? sessions.find((s) => agentRoot(s) === root)?.id;
}

/**
 * Resolve one `source_session` entry the way the completion service matches
 * it (by id, else by display name). An id wins outright; a name matches every
 * agent carrying it. Unmatched entries pass through so the caller can warn.
 */
function resolveSourceSession(entry: string, sessions: SessionInfo[]): string[] {
	if (sessions.some((s) => s.id === entry)) return [entry];
	const byName = sessions.filter((s) => s.name === entry).map((s) => s.id);
	return byName.length > 0 ? byName : [entry];
}

/**
 * Every agent a set of subscriptions needs: its target (or `unownedTarget` for
 * a subscription with no `agent_id`), its fan-out targets, and the upstream
 * agents an `agent.completed` chain waits on.
 */
function referencedAgentIds(
	subs: RawSubscription[],
	sessions: SessionInfo[],
	unownedTarget?: string
): string[] {
	const ids: string[] = [];
	for (const sub of subs) {
		const targets = asStringList(sub.agent_id);
		if (targets.length === 0 && unownedTarget) targets.push(unownedTarget);
		ids.push(...targets);
		ids.push(...asStringList(sub.source_session_ids));
		for (const entry of asStringList(sub.source_session)) {
			ids.push(...resolveSourceSession(entry, sessions));
		}
		ids.push(...asStringList(sub.fan_out_ids));
	}
	return ids;
}

/** Rewrite one subscription's prompt-file references to root-relative paths, collecting the files. */
function collectPromptFiles(
	sub: RawSubscription,
	root: string,
	onFile: (relative: string) => void
): RawSubscription {
	const out: RawSubscription = { ...sub };
	const name = typeof sub.name === 'string' ? sub.name : '(unnamed)';
	for (const field of ['prompt_file', 'output_prompt_file'] as const) {
		const ref = sub[field];
		if (typeof ref === 'string' && ref) {
			const rel = resolveContainedFile(root, ref, `Subscription "${name}" ${field}`);
			out[field] = rel;
			onFile(rel);
		}
	}
	if (Array.isArray(sub.fan_out_prompt_files)) {
		out.fan_out_prompt_files = sub.fan_out_prompt_files.map((ref) => {
			if (typeof ref !== 'string' || !ref) return ref;
			const rel = resolveContainedFile(root, ref, `Subscription "${name}" fan_out_prompt_files`);
			onFile(rel);
			return rel;
		});
	}
	return out;
}

function buildAgentSettings(
	session: SessionInfo,
	dataDir: string,
	workspaceKey: string,
	root: string,
	autoRun: CueBundleAgentSettings['autoRun'],
	builder: BundleBuilder
): CueBundleAgentSettings {
	const settings: CueBundleAgentSettings = {
		id: session.id,
		name: session.name,
		toolType: session.toolType,
		workspace: workspaceKey,
	};
	if (session.cwd) {
		const cwd = path.resolve(session.cwd);
		if (isWithin(root, cwd)) settings.cwd = toPosix(path.relative(root, cwd));
		else
			builder.warnings.add(
				`Agent "${session.name}" works outside its project root; its working directory was not exported.`
			);
	}
	if (autoRun) settings.autoRun = autoRun;
	if (session.customModel) settings.customModel = session.customModel;
	if (session.customEffort) settings.customEffort = session.customEffort;
	if (session.customArgs) settings.customArgs = session.customArgs;
	if (typeof session.customContextWindow === 'number') {
		settings.customContextWindow = session.customContextWindow;
	}
	if (session.newSessionMessage) settings.newSessionMessage = session.newSessionMessage;
	if (session.nudgeMessage) settings.nudgeMessage = session.nudgeMessage;
	if (typeof session.enableMaestroP === 'boolean') settings.enableMaestroP = session.enableMaestroP;
	if (session.maestroPMode) settings.maestroPMode = session.maestroPMode;

	// The effective env is the agent's own record OR the provider's, never a
	// merge (`effectiveAgentCustomEnvVars`). Parked vars live in a separate
	// `*Disabled` record that is simply never read here.
	const env = effectiveAgentCustomEnvVars(
		session.customEnvVars,
		readProviderEnv(dataDir, session.toolType)
	);
	const values: Record<string, string> = {};
	const required: string[] = [];
	const machineSpecific: string[] = [];
	const secretByValue: string[] = [];
	for (const key of Object.keys(env).sort()) {
		const value = env[key];
		if (isSecretEnvKey(key)) required.push(key);
		else if (looksLikeSecretValue(value)) {
			required.push(key);
			secretByValue.push(key);
		} else if (typeof value === 'string' && (path.isAbsolute(value) || value.startsWith('~'))) {
			machineSpecific.push(key);
		} else values[key] = String(value);
	}
	if (secretByValue.length > 0) {
		builder.warnings.add(
			`Agent "${session.name}" sets ${secretByValue.join(', ')} to a value that looks like a credential; ${secretByValue.length === 1 ? 'it was' : 'they were'} exported by name only. Set ${secretByValue.length === 1 ? 'it' : 'them'} again after import.`
		);
	}
	if (machineSpecific.length > 0) {
		builder.warnings.add(
			`Agent "${session.name}" sets ${machineSpecific.join(', ')} to a local path; set ${machineSpecific.length === 1 ? 'it' : 'them'} again after import.`
		);
	}
	if (Object.keys(values).length || required.length || machineSpecific.length) {
		settings.env = {
			...(Object.keys(values).length ? { values } : {}),
			...(required.length ? { required } : {}),
			...(machineSpecific.length ? { machineSpecific } : {}),
		};
	}
	return settings;
}

/** Every `.md` under a folder, as folder-relative POSIX paths, sorted. */
function listMarkdownFiles(folder: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
				out.push(toPosix(path.relative(folder, full)));
			}
		}
	};
	walk(folder);
	return out.sort();
}

/** Strings that must never appear in a generated file, each also in its JSON-escaped form. */
function forbiddenNeedles(roots: Iterable<string>): string[] {
	const needles = new Set<string>();
	for (const raw of roots) {
		if (!raw || raw.length < 2) continue;
		const resolved = path.resolve(raw);
		if (resolved === path.parse(resolved).root) continue;
		needles.add(resolved);
		needles.add(JSON.stringify(resolved).slice(1, -1));
		needles.add(toPosix(resolved));
	}
	return [...needles];
}

function assertNoLocalPaths(
	builder: BundleBuilder,
	generated: Set<string>,
	needles: string[]
): void {
	for (const archivePath of [...generated].sort()) {
		const text = builder.files.get(archivePath)?.toString('utf-8') ?? '';
		const hit = needles.find((needle) => text.includes(needle));
		if (hit) {
			throw new Error(
				`Refusing to export: ${archivePath} would contain the local path "${hit}". Make the reference project-relative and try again.`
			);
		}
	}
}

function buildReadme(manifest: Omit<CueBundleManifest, 'files'>): string {
	const kindLabel = manifest.kind === 'maestro-pipeline' ? 'Cue pipeline' : 'Maestro agent';
	const lines: string[] = [
		`# ${manifest.name}`,
		'',
		`A ${kindLabel} bundle exported from Maestro ${manifest.producer.version}. It needs Cue engine ${manifest.minEngineVersion} or newer.`,
		'',
		'## Agents',
		'',
		...manifest.agents.map((a) => `- **${a.name}** (${a.toolType}), workspace \`${a.workspace}\``),
		'',
		'## Workspaces',
		'',
		...manifest.workspaces.map((w) => {
			const remote = w.source?.gitRemote ? ` - clone from ${w.source.gitRemote}` : '';
			return `- \`${w.key}\` (${w.name})${remote}`;
		}),
		'',
		'## Requirements',
		'',
		`- Events: ${manifest.requirements.events.length ? manifest.requirements.events.map((e) => `\`${e}\``).join(', ') : 'none'}`,
		`- Tools: ${manifest.requirements.tools.length ? manifest.requirements.tools.map((t) => `\`${t}\``).join(', ') : 'none'}`,
		`- Secrets: ${manifest.requirements.secrets.length ? manifest.requirements.secrets.map((s) => `\`${s}\``).join(', ') : 'none'}`,
		'',
	];
	if (manifest.requirements.secrets.length > 0) {
		lines.push(
			'Secret values are never included. Set each secret above as an environment variable on the machine that imports this bundle.',
			''
		);
	}
	if (manifest.warnings?.length) {
		lines.push('## Warnings', '', ...manifest.warnings.map((w) => `- ${w}`), '');
	}
	return lines.join('\n');
}

async function writeZip(outputPath: string, files: Map<string, Buffer>): Promise<void> {
	await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
	const tmpPath = `${outputPath}.${process.pid}.tmp`;
	try {
		await new Promise<void>((resolve, reject) => {
			const output = fs.createWriteStream(tmpPath);
			const archive = archiver('zip', { zlib: { level: 9 } });
			output.on('close', () => resolve());
			output.on('error', reject);
			archive.on('error', reject);
			archive.on('warning', reject);
			archive.pipe(output);
			for (const name of [...files.keys()].sort()) {
				archive.append(files.get(name)!, { name, date: CUE_BUNDLE_FIXED_MTIME, mode: 0o644 });
			}
			void archive.finalize();
		});
		await fs.promises.rename(tmpPath, outputPath);
	} catch (error) {
		await fs.promises.rm(tmpPath, { force: true });
		throw error;
	}
}

/**
 * Export a pipeline or an agent to a bundle zip. Throws with a user-facing
 * message on any refusal (ambiguous options, unknown pipeline, inline secret,
 * escaping prompt file, path leak).
 */
export async function exportCueBundle(
	options: CueBundleExportOptions
): Promise<CueBundleExportResult> {
	if (!!options.pipeline === !!options.agentId) {
		throw new Error('Pass exactly one of --pipeline or --agent');
	}
	if (!options.outputPath) throw new Error('An output path is required');
	const dataDir = path.resolve(options.dataDir);
	const sessions = readSessions(dataDir);
	const sessionById = new Map(sessions.map((s) => [s.id, s]));
	const builder = new BundleBuilder();
	const createdAt = resolveCreatedAt(options);

	let kind: CueBundleKind;
	let bundleName: string;
	let pipeline: CuePipeline | undefined;
	const agentIds = new Set<string>();
	/** Kept subscriptions + settings, keyed by project root. */
	const configByRoot = new Map<
		string,
		{ subs: RawSubscription[]; settings?: Record<string, unknown> }
	>();
	const distinctRoots = sortedUnique(sessions.map(agentRoot));

	if (options.pipeline) {
		kind = 'maestro-pipeline';
		pipeline = findPipeline(dataDir, options.pipeline);
		bundleName = pipeline?.name ?? options.pipeline;
		for (const root of distinctRoots) {
			const doc = readCueDocument(root);
			const subs = rawSubscriptions(doc).filter((s) => s.pipeline_name === bundleName);
			if (subs.length === 0) continue;
			configByRoot.set(root, { subs, settings: doc?.settings });
			const owner = resolveOwnerId(doc?.settings?.owner_agent_id, sessions);
			if (owner) agentIds.add(owner);
			const unownedTarget = resolveUnownedTarget(doc?.settings?.owner_agent_id, root, sessions);
			for (const id of referencedAgentIds(subs, sessions, unownedTarget)) agentIds.add(id);
		}
		if (!pipeline && configByRoot.size === 0) {
			throw new Error(`Pipeline not found: ${options.pipeline}`);
		}
		if (configByRoot.size === 0) {
			builder.warnings.add(`Pipeline "${bundleName}" has no subscriptions in any cue.yaml.`);
		}
		if (!pipeline) {
			builder.warnings.add(
				`Pipeline "${bundleName}" has no saved layout; the editor will lay it out on import.`
			);
		}
	} else {
		kind = 'maestro-agent';
		const agent = sessionById.get(options.agentId!);
		if (!agent) throw new Error(`Agent not found: ${options.agentId}`);
		bundleName = agent.name;
		agentIds.add(agent.id);
		const root = agentRoot(agent);
		const doc = readCueDocument(root);
		const unownedTarget = resolveUnownedTarget(doc?.settings?.owner_agent_id, root, sessions);
		const subs = rawSubscriptions(doc).filter((s) =>
			typeof s.agent_id === 'string' && s.agent_id
				? s.agent_id === agent.id
				: unownedTarget === agent.id
		);
		if (doc) configByRoot.set(root, { subs, settings: doc.settings });
		const foreign = sortedUnique(referencedAgentIds(subs, sessions, unownedTarget)).filter(
			(id) => id !== agent.id
		);
		if (foreign.length > 0) {
			builder.warnings.add(
				`Subscriptions reference other agents that are not in this bundle: ${foreign.map((id) => sessionById.get(id)?.name ?? id).join(', ')}.`
			);
		}
	}

	// Inline webhook secrets are refused before anything else is read.
	for (const { subs } of configByRoot.values()) {
		for (const sub of subs) {
			const webhook = sub.webhook as Record<string, unknown> | undefined;
			if (typeof webhook?.secret === 'string' && webhook.secret) {
				const name = typeof sub.name === 'string' ? sub.name : '(unnamed)';
				if (!options.allowInlineSecrets) {
					throw new Error(
						`Subscription "${name}" has a literal webhook.secret. Move it to webhook.secret_env, or pass --allow-inline-secrets to export it anyway.`
					);
				}
				builder.warnings.add(`Subscription "${name}" carries a literal webhook secret.`);
			}
		}
	}

	const includedAgents: SessionInfo[] = [];
	for (const id of [...agentIds].sort()) {
		const session = sessionById.get(id);
		if (session) includedAgents.push(session);
		else builder.warnings.add(`Subscriptions reference an agent that no longer exists: ${id}.`);
	}

	const workspaceRoots = sortedUnique([...configByRoot.keys(), ...includedAgents.map(agentRoot)]);
	const keyByRoot = assignWorkspaceKeys(workspaceRoots);
	const workspaces = new Map<string, WorkspaceBuild>();
	for (const root of workspaceRoots) {
		const config = configByRoot.get(root);
		workspaces.set(root, {
			root,
			key: keyByRoot.get(root)!,
			subscriptions: config?.subs ?? [],
			settings: config?.settings,
			contributedConfig: !!config,
		});
	}

	const generated = new Set<string>();
	const addGenerated = (archivePath: string, content: string) => {
		builder.add(archivePath, content);
		generated.add(archivePath);
	};

	// Workspace cue.yaml + prompt files.
	const manifestWorkspaces: CueBundleWorkspace[] = [];
	const events = new Set<string>();
	const secrets = new Set<string>();
	for (const ws of workspaces.values()) {
		const entry: CueBundleWorkspace = { key: ws.key, name: path.basename(ws.root) };
		if (ws.contributedConfig) {
			const subs = ws.subscriptions.map((sub) =>
				collectPromptFiles(sub, ws.root, (rel) => {
					builder.add(`workspaces/${ws.key}/${rel}`, fs.readFileSync(path.join(ws.root, rel)));
				})
			);
			for (const sub of subs) {
				if (typeof sub.event === 'string') events.add(sub.event);
				const secretEnv = (sub.webhook as Record<string, unknown> | undefined)?.secret_env;
				if (typeof secretEnv === 'string' && secretEnv) secrets.add(secretEnv);
			}
			const doc: Record<string, unknown> = {};
			if (ws.settings && typeof ws.settings === 'object') doc.settings = ws.settings;
			doc.subscriptions = subs;
			const cuePath = `workspaces/${ws.key}/${CUE_CONFIG_PATH}`;
			addGenerated(cuePath, yaml.dump(doc, { lineWidth: -1, noRefs: true }));
			entry.cueConfig = cuePath;
		}
		const source = readGitSource(ws.root);
		if (source) entry.source = source;
		manifestWorkspaces.push(entry);
	}

	// Agents: settings, playbooks, Auto Run documents.
	const manifestAgents: CueBundleAgent[] = [];
	for (const session of includedAgents) {
		const root = agentRoot(session);
		const wsKey = keyByRoot.get(root)!;
		if (session.sessionSshRemoteConfig?.enabled) {
			builder.warnings.add(
				`Agent "${session.name}" runs over SSH on the exporting machine; its remote configuration was not exported.`
			);
		}

		const folder = session.autoRunFolderPath ? path.resolve(session.autoRunFolderPath) : undefined;
		const folderInWorkspace = folder ? isWithin(root, folder) : false;
		let autoRun: CueBundleAgentSettings['autoRun'];
		if (folder) {
			autoRun = folderInWorkspace
				? { workspace: wsKey, path: toPosix(path.relative(root, folder)) }
				: { bundlePath: `autorun/${session.id}` };
		}
		const addDocument = (relToFolder: string) => {
			if (!folder) return;
			const abs = path.resolve(folder, relToFolder);
			if (!isWithin(folder, abs)) {
				throw new Error(
					`Agent "${session.name}" references a playbook document outside its Auto Run folder: ${relToFolder}`
				);
			}
			if (!fs.existsSync(abs)) {
				builder.warnings.add(
					`Agent "${session.name}" references a missing playbook document: ${relToFolder}.`
				);
				return;
			}
			const archivePath = folderInWorkspace
				? `workspaces/${wsKey}/${toPosix(path.relative(root, abs))}`
				: `autorun/${session.id}/${toPosix(relToFolder)}`;
			builder.add(archivePath, fs.readFileSync(abs));
		};

		const playbooks = readPlaybooks(dataDir, session.id);
		for (const playbook of playbooks) {
			for (const doc of playbook.documents ?? []) {
				if (typeof doc?.filename === 'string' && doc.filename) addDocument(`${doc.filename}.md`);
			}
		}
		if (kind === 'maestro-agent' && folder) {
			for (const rel of listMarkdownFiles(folder)) addDocument(rel);
		} else if (playbooks.length > 0 && !folder) {
			builder.warnings.add(
				`Agent "${session.name}" has playbooks but no Auto Run folder; its documents were not exported.`
			);
		}

		const settings = buildAgentSettings(session, dataDir, wsKey, root, autoRun, builder);
		for (const key of settings.env?.required ?? []) secrets.add(key);
		const settingsPath = `agents/${session.id}.json`;
		addGenerated(settingsPath, JSON.stringify(settings, null, '\t') + '\n');
		const agentEntry: CueBundleAgent = {
			id: session.id,
			name: session.name,
			toolType: session.toolType,
			workspace: wsKey,
			settings: settingsPath,
		};
		if (playbooks.length > 0) {
			const playbooksPath = `agents/${session.id}/playbooks.json`;
			addGenerated(playbooksPath, JSON.stringify({ playbooks }, null, '\t') + '\n');
			agentEntry.playbooks = playbooksPath;
		}
		manifestAgents.push(agentEntry);
	}

	if (pipeline) {
		addGenerated(CUE_BUNDLE_LAYOUT_PATH, JSON.stringify(pipeline, null, '\t') + '\n');
	}

	const tools = new Set<string>();
	if ([...events].some((e) => e.startsWith('github.'))) tools.add('gh');
	if (manifestWorkspaces.some((w) => w.source?.gitRemote)) tools.add('git');
	const requirements: CueBundleRequirements = {
		events: sortedUnique(events),
		tools: sortedUnique(tools),
		secrets: sortedUnique(secrets),
	};

	const warnings = sortedUnique(builder.warnings);
	const head: Omit<CueBundleManifest, 'files'> = {
		bundleVersion: CUE_BUNDLE_VERSION,
		kind,
		producer: { app: 'maestro', version: options.producerVersion ?? '0.0.0-dev' },
		minEngineVersion: CUE_BUNDLE_MIN_ENGINE_VERSION,
		name: bundleName,
		workspaces: manifestWorkspaces,
		agents: manifestAgents,
		requirements,
		...(warnings.length ? { warnings } : {}),
		...(createdAt ? { createdAt } : {}),
	};
	addGenerated(CUE_BUNDLE_README_PATH, buildReadme(head));

	const files: CueBundleFileEntry[] = [...builder.files.keys()].sort().map((p) => {
		const buf = builder.files.get(p)!;
		return { path: p, sha256: sha256(buf), size: buf.length };
	});
	const manifest: CueBundleManifest = { ...head, files };
	addGenerated(CUE_BUNDLE_MANIFEST_PATH, JSON.stringify(manifest, null, '\t') + '\n');

	// Last line of defense: no generated file may name a local root.
	const localRoots = [dataDir, os.homedir(), ...workspaceRoots];
	for (const s of includedAgents) {
		for (const p of [
			s.cwd,
			s.projectRoot,
			s.fullPath,
			s.customPath,
			s.maestroPPath,
			s.autoRunFolderPath,
		]) {
			if (p) localRoots.push(p);
		}
	}
	assertNoLocalPaths(builder, generated, forbiddenNeedles(localRoots));

	const outputPath = path.resolve(options.outputPath);
	await writeZip(outputPath, builder.files);
	const zipBytes = await fs.promises.readFile(outputPath);
	return { outputPath, manifest, size: zipBytes.length, sha256: sha256(zipBytes) };
}
