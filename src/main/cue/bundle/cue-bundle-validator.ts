/**
 * Cue bundle validator - proves a bundle zip is intact, complete, and runnable
 * by this engine before anything is imported from it.
 *
 * Every check reports a structured issue (`code`, `message`, optional archive
 * `file`) rather than throwing, so a caller sees ALL the problems in one pass.
 * Only an archive that cannot be read at all throws.
 *
 * Like the exporter, this never imports Electron: the CLI loads it through a
 * dynamic `import()` and the engine-coupling ratchet covers this folder. The
 * running version is passed in by the caller rather than read from
 * `package.json`, so the check describes whichever program is actually asking.
 */

import * as crypto from 'crypto';
import * as yaml from 'js-yaml';
import { compareVersions } from '../../../shared/pathUtils';
import {
	CUE_BUNDLE_MANIFEST_PATH,
	CUE_BUNDLE_VERSION,
	type CueBundleAgentSettings,
	type CueBundleManifest,
} from '../../../shared/cue-bundle-types';
import { isUnsafeZipEntryName, readZipArchive } from '../../utils/zip-archive';
import { validateCueConfigDocument } from '../config/cue-config-validator';
import {
	describeSecretProblem,
	resolveSecrets,
	type SecretProblem,
	type SecretSource,
} from '../../../shared/serverSecrets';

export interface CueBundleValidationIssue {
	/** Stable kebab-case identifier, for scripts. */
	code: string;
	message: string;
	/** Archive path the issue is about, when there is one. */
	file?: string;
}

/**
 * Whether the machine running the validation supplies one required secret,
 * looked up exactly as a launch looks it up (`lookupSecret`). Names, sources
 * and paths only: the value is never part of it.
 */
export interface CueBundleSecretCheck {
	name: string;
	status: 'found' | 'missing' | 'unusable';
	/** Where the value was found. */
	source?: SecretSource;
	/** Why a secret file that exists cannot be used. */
	problem?: SecretProblem;
	/** The unusable file. */
	path?: string;
}

export interface CueBundleValidationResult {
	/** True when there are no errors. Warnings never invalidate a bundle. */
	valid: boolean;
	errors: CueBundleValidationIssue[];
	warnings: CueBundleValidationIssue[];
	/** The parsed manifest, when one could be read. */
	manifest?: CueBundleManifest;
	/** Each of `requirements.secrets` on this machine, sorted by name. Only with `checkEnv`. */
	secrets?: CueBundleSecretCheck[];
}

export interface CueBundleValidateOptions {
	/** Version of the program asking (the CLI passes its own). */
	runningVersion: string;
	/**
	 * Also check that THIS machine supplies each of `requirements.secrets`: a
	 * systemd credential, a `/run/secrets` file or an environment variable.
	 * One that is missing or unusable is a warning, since the bundle itself is
	 * fine; it is opt-in because a bundle is often checked on a desktop while
	 * its secrets exist only on the server it is for.
	 */
	checkEnv?: boolean;
	/** Environment consulted by `checkEnv` (and for `CREDENTIALS_DIRECTORY`). Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Override the `/run/secrets` directory for `checkEnv`; `null` disables it. Tests use this. */
	runSecretsDir?: string | null;
}

type RawSubscription = Record<string, unknown>;

function asStringList(value: unknown): string[] {
	if (typeof value === 'string') return value ? [value] : [];
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && !!v);
	return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A bundle zip's entries, read once and shared by the validator and the importer. */
export interface CueBundleArchive {
	/** File entries by normalized archive path. Unsafe names are left out. */
	entries: Map<string, Buffer>;
	/** Entry names that were absolute or parent-relative, in archive order. */
	unsafeNames: string[];
}

/**
 * Read every file entry of the bundle at `bundlePath`. Throws only when the
 * file is missing, is not a readable zip, or trips the zip reader's caps.
 */
export function readCueBundleArchive(bundlePath: string): CueBundleArchive {
	const zip = readZipArchive(bundlePath);
	const entries = new Map<string, Buffer>();
	const unsafeNames: string[] = [];
	for (const entry of zip.getEntries()) {
		if (entry.isDirectory) continue;
		if (isUnsafeZipEntryName(entry.entryName)) {
			unsafeNames.push(entry.entryName);
			continue;
		}
		entries.set(entry.entryName, entry.getData());
	}
	return { entries, unsafeNames };
}

/**
 * Validate the bundle at `bundlePath`. Throws only when the file is missing or
 * is not a readable zip; every other problem is returned as an issue.
 */
export async function validateCueBundle(
	bundlePath: string,
	options: CueBundleValidateOptions
): Promise<CueBundleValidationResult> {
	return validateCueBundleArchive(readCueBundleArchive(bundlePath), options);
}

/** Validate a bundle already read with {@link readCueBundleArchive}. Never throws. */
export function validateCueBundleArchive(
	archive: CueBundleArchive,
	options: CueBundleValidateOptions
): CueBundleValidationResult {
	const { entries } = archive;
	const errors: CueBundleValidationIssue[] = [];
	const warnings: CueBundleValidationIssue[] = [];
	const error = (code: string, message: string, file?: string) =>
		errors.push(file ? { code, message, file } : { code, message });
	const warn = (code: string, message: string, file?: string) =>
		warnings.push(file ? { code, message, file } : { code, message });
	let secretChecks: CueBundleSecretCheck[] | undefined;
	const done = (manifest?: CueBundleManifest): CueBundleValidationResult => ({
		valid: errors.length === 0,
		errors,
		warnings,
		...(manifest ? { manifest } : {}),
		...(secretChecks ? { secrets: secretChecks } : {}),
	});

	for (const name of archive.unsafeNames) {
		error('unsafe-path', 'Archive entry has an absolute or parent-relative path', name);
	}

	// ─── Manifest ────────────────────────────────────────────────────────────
	const manifestBytes = entries.get(CUE_BUNDLE_MANIFEST_PATH);
	if (!manifestBytes) {
		error('manifest-missing', 'The archive has no manifest.json', CUE_BUNDLE_MANIFEST_PATH);
		return done();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(manifestBytes.toString('utf-8'));
	} catch (e) {
		error(
			'manifest-invalid',
			`manifest.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
			CUE_BUNDLE_MANIFEST_PATH
		);
		return done();
	}
	if (
		!isRecord(parsed) ||
		!Array.isArray(parsed.files) ||
		!Array.isArray(parsed.agents) ||
		!Array.isArray(parsed.workspaces) ||
		!isRecord(parsed.requirements)
	) {
		error(
			'manifest-invalid',
			'manifest.json is missing one of files, agents, workspaces, or requirements',
			CUE_BUNDLE_MANIFEST_PATH
		);
		return done();
	}
	const manifest = parsed as unknown as CueBundleManifest;

	if (manifest.bundleVersion !== CUE_BUNDLE_VERSION) {
		error(
			'unsupported-bundle-version',
			`Bundle format version ${String(manifest.bundleVersion)} is not supported (expected ${CUE_BUNDLE_VERSION})`,
			CUE_BUNDLE_MANIFEST_PATH
		);
	}
	if (typeof manifest.minEngineVersion !== 'string' || !manifest.minEngineVersion) {
		error('manifest-invalid', 'manifest.json has no minEngineVersion', CUE_BUNDLE_MANIFEST_PATH);
	} else if (compareVersions(manifest.minEngineVersion, options.runningVersion) > 0) {
		error(
			'engine-too-old',
			`This bundle requires Cue engine ${manifest.minEngineVersion} or newer; this is ${options.runningVersion}`,
			CUE_BUNDLE_MANIFEST_PATH
		);
	}

	// ─── Integrity, both directions ──────────────────────────────────────────
	const listed = new Set<string>();
	for (const file of manifest.files) {
		if (!isRecord(file) || typeof file.path !== 'string') {
			error(
				'manifest-invalid',
				'manifest.files has an entry without a path',
				CUE_BUNDLE_MANIFEST_PATH
			);
			continue;
		}
		if (listed.has(file.path)) {
			error('duplicate-file', 'Listed more than once in manifest.files', file.path);
			continue;
		}
		listed.add(file.path);
		const bytes = entries.get(file.path);
		if (!bytes) {
			error('file-missing', 'Listed in manifest.files but absent from the archive', file.path);
			continue;
		}
		if (bytes.length !== file.size) {
			error(
				'size-mismatch',
				`Size is ${bytes.length} bytes; the manifest records ${String(file.size)}`,
				file.path
			);
		}
		const actual = crypto.createHash('sha256').update(bytes).digest('hex');
		if (actual !== file.sha256) {
			error('hash-mismatch', 'SHA-256 does not match the manifest', file.path);
		}
	}
	for (const name of [...entries.keys()].sort()) {
		if (name !== CUE_BUNDLE_MANIFEST_PATH && !listed.has(name)) {
			error('unlisted-file', 'Present in the archive but not listed in manifest.files', name);
		}
	}

	/** A path the manifest or a config points at must be a real archive entry. */
	const requireEntry = (archivePath: string, code: string, message: string, from?: string) => {
		if (isUnsafeZipEntryName(archivePath)) {
			error(
				'unsafe-path',
				`${message} has an absolute or parent-relative path: ${archivePath}`,
				from
			);
			return false;
		}
		if (!entries.has(archivePath)) {
			error(code, `${message} is missing from the archive: ${archivePath}`, from);
			return false;
		}
		return true;
	};

	// ─── Agents ──────────────────────────────────────────────────────────────
	const secrets = new Set(asStringList(manifest.requirements.secrets));
	const workspaceKeys = new Set(manifest.workspaces.filter(isRecord).map((w) => String(w.key)));
	const agentIds = new Set<string>();
	const agentNames = new Set<string>();
	for (const agent of manifest.agents) {
		if (!isRecord(agent) || typeof agent.id !== 'string') {
			error(
				'manifest-invalid',
				'manifest.agents has an entry without an id',
				CUE_BUNDLE_MANIFEST_PATH
			);
			continue;
		}
		agentIds.add(agent.id);
		if (typeof agent.name === 'string') agentNames.add(agent.name);
	}
	/** Resolve a reference that may hold an agent id or a display name. */
	const knowsAgent = (ref: string) => agentIds.has(ref) || agentNames.has(ref);

	for (const agent of manifest.agents) {
		if (!isRecord(agent) || typeof agent.id !== 'string') continue;
		if (!workspaceKeys.has(String(agent.workspace))) {
			error(
				'unknown-workspace',
				`Agent "${String(agent.name)}" names workspace "${String(agent.workspace)}", which the bundle does not define`,
				CUE_BUNDLE_MANIFEST_PATH
			);
		}
		if (typeof agent.playbooks === 'string') {
			requireEntry(agent.playbooks, 'file-missing', `Playbooks for agent "${String(agent.name)}"`);
		}
		if (
			typeof agent.settings !== 'string' ||
			!requireEntry(agent.settings, 'file-missing', `Settings for agent "${String(agent.name)}"`)
		) {
			continue;
		}
		let settings: CueBundleAgentSettings;
		try {
			settings = JSON.parse(entries.get(agent.settings)!.toString('utf-8'));
		} catch {
			error('settings-invalid', 'Agent settings are not valid JSON', agent.settings);
			continue;
		}
		for (const key of asStringList(settings.env?.required)) {
			if (!secrets.has(key)) {
				error(
					'secret-not-declared',
					`Agent "${String(agent.name)}" requires ${key}, which is not in requirements.secrets`,
					agent.settings
				);
			}
		}
	}

	// ─── Workspaces' cue.yaml ────────────────────────────────────────────────
	// Parse every config first: a `source_sub` may name a subscription declared
	// in another workspace, so the full set of names must exist before any
	// subscription is checked.
	const configs: Array<{ key: string; cuePath: string; doc: Record<string, unknown> }> = [];
	for (const ws of manifest.workspaces) {
		if (!isRecord(ws) || typeof ws.cueConfig !== 'string') continue;
		const cuePath = ws.cueConfig;
		if (!requireEntry(cuePath, 'file-missing', `cue.yaml for workspace "${String(ws.key)}"`)) {
			continue;
		}
		let doc: unknown;
		try {
			doc = yaml.load(entries.get(cuePath)!.toString('utf-8'));
		} catch (e) {
			error(
				'cue-config-invalid',
				`Not valid YAML: ${e instanceof Error ? e.message : String(e)}`,
				cuePath
			);
			continue;
		}
		for (const message of validateCueConfigDocument(doc).errors) {
			error('cue-config-invalid', message, cuePath);
		}
		if (isRecord(doc)) configs.push({ key: String(ws.key), cuePath, doc });
	}
	const subsOf = (doc: Record<string, unknown>) =>
		(Array.isArray(doc.subscriptions)
			? doc.subscriptions.filter(isRecord)
			: []) as RawSubscription[];
	const allSubscriptionNames = new Set(
		configs.flatMap(({ doc }) =>
			subsOf(doc).flatMap((sub) => (typeof sub.name === 'string' ? [sub.name] : []))
		)
	);

	// An agent bundle carries one agent, so a chain reaching outside it is
	// expected: the importer wires it to agents it already has. A pipeline
	// bundle claims to be the whole chain, so the same reference is a hole.
	const externalRef = manifest.kind === 'maestro-agent' ? warn : error;

	for (const { key, cuePath, doc } of configs) {
		const owner = isRecord(doc.settings) ? doc.settings.owner_agent_id : undefined;
		if (typeof owner === 'string' && owner && !knowsAgent(owner)) {
			error(
				'unknown-agent',
				`settings.owner_agent_id "${owner}" is not an agent in this bundle`,
				cuePath
			);
		}

		for (const sub of subsOf(doc)) {
			const name = typeof sub.name === 'string' ? sub.name : '(unnamed)';
			const label = `Subscription "${name}"`;

			if (name.includes(':')) {
				error(
					'name-has-colon',
					`${label} contains ":", which Cue uses to separate agent and subscription in fan-in keys`,
					cuePath
				);
			}
			if (typeof sub.interval_minutes === 'number' && sub.interval_minutes < 1) {
				error(
					'sub-minute-heartbeat',
					`${label} fires every ${sub.interval_minutes} minutes; the minimum is 1`,
					cuePath
				);
			}
			if (isRecord(sub.command) && sub.command.mode === 'cli') {
				error(
					'desktop-only-command',
					`${label} uses command.mode "cli", which only runs inside the desktop app`,
					cuePath
				);
			}

			for (const id of asStringList(sub.agent_id)) {
				if (!agentIds.has(id)) {
					error(
						'unknown-agent',
						`${label} targets agent "${id}", which is not in this bundle`,
						cuePath
					);
				}
			}
			for (const ref of asStringList(sub.source_session)) {
				if (!knowsAgent(ref)) {
					externalRef(
						'unknown-agent',
						`${label} waits on source_session "${ref}", which is not in this bundle`,
						cuePath
					);
				}
			}
			for (const field of ['source_session_ids', 'fan_out_ids'] as const) {
				for (const id of asStringList(sub[field])) {
					if (!agentIds.has(id)) {
						externalRef(
							'unknown-agent',
							`${label} lists ${field} "${id}", which is not in this bundle`,
							cuePath
						);
					}
				}
			}
			for (const upstream of asStringList(sub.source_sub)) {
				if (!allSubscriptionNames.has(upstream)) {
					externalRef(
						'unknown-subscription',
						`${label} waits on source_sub "${upstream}", which no subscription in this bundle declares`,
						cuePath
					);
				}
			}

			const promptRefs = [
				...asStringList(sub.prompt_file),
				...asStringList(sub.output_prompt_file),
				...asStringList(sub.fan_out_prompt_files),
			];
			for (const ref of promptRefs) {
				requireEntry(
					`workspaces/${key}/${ref}`,
					'prompt-file-missing',
					`${label} prompt file "${ref}"`,
					cuePath
				);
			}

			const secretEnv = isRecord(sub.webhook) ? sub.webhook.secret_env : undefined;
			if (typeof secretEnv === 'string' && secretEnv && !secrets.has(secretEnv)) {
				error(
					'secret-not-declared',
					`${label} reads webhook.secret_env ${secretEnv}, which is not in requirements.secrets`,
					cuePath
				);
			}
		}
	}

	// ─── Importing machine's environment ─────────────────────────────────────
	// The same lookup a launch makes, so a secret supplied only as a file is not
	// reported missing. The values it reads are dropped here.
	if (options.checkEnv) {
		const resolved = resolveSecrets([...secrets], {
			env: options.env,
			runSecretsDir: options.runSecretsDir,
		});
		secretChecks = [
			...resolved.found.map(({ name, source }) => ({ name, status: 'found' as const, source })),
			...resolved.missing.map((name) => ({ name, status: 'missing' as const })),
			...resolved.unusable.map(({ name, problem, path }) => ({
				name,
				status: 'unusable' as const,
				problem,
				...(path ? { path } : {}),
			})),
		].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const check of secretChecks) {
			if (check.status === 'missing') {
				warnings.push({
					code: 'secret-unset',
					message: `${check.name} is not set in this environment`,
				});
			} else if (check.status === 'unusable') {
				warnings.push({
					code: 'secret-unusable',
					message: describeSecretProblem({
						name: check.name,
						problem: check.problem!,
						path: check.path,
					}),
				});
			}
		}
	}

	return done(manifest);
}
