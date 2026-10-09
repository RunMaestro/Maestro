// Bundle commands - pack a Cue pipeline or a single agent into a portable,
// deterministic zip (`src/shared/cue-bundle-types.ts`), check or describe one,
// and import one into a data directory.
//
// With the desktop app running (and no --data-dir), export and import go
// through it: the same functions as the Cue modal's Bundles tab
// (`src/main/cue-bundle-service.ts`), so agents land in the running app
// instead of a sessions file it would overwrite. Otherwise they read and
// write the data directory straight off disk, and import refuses while an
// app or engine runs against it. The exporter, validator, importer, and zip
// reader are loaded with a dynamic `import()` so archiver, js-yaml, and the
// Cue config reader stay out of every other command's startup path.

import { assertUserDataDirExists, resolveUserDataDir } from '../../shared/userDataDir';
import { resolveAgentId } from '../services/storage';
import { readSessionsStoreFile } from '../../main/stores/sessions-store-file';
import { resolveCliPath } from '../utils/parse';
import { ExitCode } from '../exit-codes';
import { isCliServerRunning } from '../../shared/cli-server-discovery';
import { withMaestroClient } from '../services/maestro-client';
import { formatSize } from '../../shared/formatters';
import type {
	CueBundleClaudeAssetSelection,
	CueBundleManifest,
} from '../../shared/cue-bundle-types';
import type {
	CueBundleExportOutcome,
	CueBundleExportRequest,
	CueBundleImportOutcome,
	CueBundleImportRequest,
} from '../../main/cue-bundle-service';
import type {
	CueBundleSecretCheck,
	CueBundleValidationIssue,
} from '../../main/cue/bundle/cue-bundle-validator';
import type {
	CueBundleImportConflict,
	CueBundleImportErrorCode,
	CueBundleImportPlan,
} from '../../main/cue/bundle/cue-bundle-importer';

export interface BundleExportOptions {
	agent?: string;
	pipeline?: string;
	output?: string;
	allowInlineSecrets?: boolean;
	dataDir?: string;
	createdAt?: string;
	/** `--no-claude-skills` sets false. */
	claudeSkills?: boolean;
	/** `--no-claude-mcp` sets false. */
	claudeMcp?: boolean;
	/** `--no-claude-memory` sets false. */
	claudeMemory?: boolean;
	json?: boolean;
}

/** Bundle work can wait on the renderer and on disk; allow more than the default 10 s. */
const APP_COMMAND_TIMEOUT_MS = 120_000;

/** Go through the running app: no explicit data dir, and the app is up. */
function shouldGoThroughApp(options: { dataDir?: string }): boolean {
	return !options.dataDir && isCliServerRunning();
}

/** Run a bundle operation in the running app and return its outcome. */
async function viaApp<T>(type: string, request: unknown): Promise<T> {
	const response = await withMaestroClient((client) =>
		client.sendCommand<{ type: string; outcome: T }>(
			{ type, request },
			`${type}_result`,
			APP_COMMAND_TIMEOUT_MS
		)
	);
	return response.outcome;
}

function claudeAssetSelection(options: BundleExportOptions): CueBundleClaudeAssetSelection {
	return {
		skills: options.claudeSkills !== false,
		mcp: options.claudeMcp !== false,
		memory: options.claudeMemory !== false,
	};
}

/**
 * Report a failure and exit. `jsonCode` and `details` are added to the JSON
 * payload only when given, so verbs that never passed them print what they
 * always printed.
 */
function fail(
	message: string,
	options: { json?: boolean },
	code = ExitCode.GeneralError,
	jsonCode?: string,
	details?: Record<string, unknown>
): never {
	if (options.json) {
		console.log(
			JSON.stringify({
				success: false,
				error: message,
				...(jsonCode ? { code: jsonCode } : {}),
				...(details && Object.keys(details).length > 0 ? { details } : {}),
			})
		);
	} else {
		console.error(`Error: ${message}`);
	}
	process.exit(code);
}

function defaultOutputName(name: string): string {
	const slug =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'bundle';
	return `${slug}.maestro-bundle.zip`;
}

export async function bundleExport(
	cliVersion: string,
	options: BundleExportOptions
): Promise<void> {
	if (!!options.agent === !!options.pipeline) {
		fail('Pass exactly one of --agent or --pipeline', options, ExitCode.InvalidUsage);
	}

	try {
		const dataDir = options.dataDir ? resolveCliPath(options.dataDir) : resolveUserDataDir();
		// Never export from a guessed directory: a missing one (an install's
		// `Maestro` vs a dev checkout's `maestro`) would otherwise read as "agent
		// not found". Only a missing directory is this error; a permission or I/O
		// error falls through to the ordinary failure below. Import is the
		// deliberate exception - it provisions a fresh data dir.
		try {
			assertUserDataDirExists(dataDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code) throw error;
			fail(
				error instanceof Error ? error.message : String(error),
				options,
				ExitCode.GeneralError,
				'DATA_DIR_NOT_FOUND'
			);
		}

		const { exportCueBundle, CueBundleExportInvalidError } =
			await import('../../main/cue/bundle/cue-bundle-exporter');

		const throughApp = shouldGoThroughApp(options);
		let agentId: string | undefined;
		let agentName: string | undefined;
		if (options.agent && throughApp) {
			// The app resolves the agent against its own list, which a custom sync
			// folder keeps out of this data directory. This lookup only names the
			// default output file, so it may find nothing.
			try {
				agentName = readSessionsStoreFile(dataDir).sessions.find(
					(s) => s.id === options.agent || s.name === options.agent
				)?.name;
			} catch {
				// Unreadable here; the app still has the agents.
			}
		} else if (options.agent) {
			const { sessions } = readSessionsStoreFile(dataDir);
			agentId = resolveAgentId(options.agent, sessions);
			agentName = sessions.find((s) => s.id === agentId)?.name;
		}

		const outputPath = resolveCliPath(
			options.output ??
				defaultOutputName(options.pipeline ?? agentName ?? options.agent ?? 'bundle')
		);

		let result: { outputPath: string; size: number; sha256: string; manifest: CueBundleManifest };
		if (throughApp) {
			const request: CueBundleExportRequest = {
				agent: options.agent,
				pipeline: options.pipeline,
				outputPath,
				allowInlineSecrets: options.allowInlineSecrets,
				createdAt: options.createdAt,
				claudeAssets: claudeAssetSelection(options),
			};
			const outcome = await viaApp<CueBundleExportOutcome>('cue_bundle_export', request);
			if (!outcome.ok) {
				fail(outcome.message, options, ExitCode.GeneralError, outcome.code, outcome.details);
			}
			result = outcome;
		} else {
			try {
				result = await exportCueBundle({
					dataDir,
					agentId,
					pipeline: options.pipeline,
					outputPath,
					allowInlineSecrets: options.allowInlineSecrets,
					createdAt: options.createdAt,
					claudeAssets: claudeAssetSelection(options),
					producerVersion: cliVersion,
				});
			} catch (error) {
				// Same code and details the app path reports for this refusal.
				if (error instanceof CueBundleExportInvalidError) {
					fail(error.message, options, ExitCode.GeneralError, error.code, error.details);
				}
				throw error;
			}
		}

		if (options.json) {
			console.log(
				JSON.stringify(
					{
						success: true,
						outputPath: result.outputPath,
						size: result.size,
						sha256: result.sha256,
						manifest: result.manifest,
					},
					null,
					2
				)
			);
			return;
		}

		const { manifest } = result;
		const lines = [
			`Exported ${manifest.kind === 'maestro-pipeline' ? 'pipeline' : 'agent'} "${manifest.name}" to ${result.outputPath}`,
			`  ${manifest.agents.length} agent${manifest.agents.length === 1 ? '' : 's'}, ${manifest.workspaces.length} workspace${manifest.workspaces.length === 1 ? '' : 's'}, ${manifest.files.length} file${manifest.files.length === 1 ? '' : 's'}`,
			`  sha256 ${result.sha256}`,
		];
		if (manifest.requirements.secrets.length > 0) {
			lines.push(`  Secrets to set on import: ${manifest.requirements.secrets.join(', ')}`);
		}
		for (const warning of manifest.warnings ?? []) {
			lines.push(`  Warning: ${warning}`);
		}
		console.log(lines.join('\n'));
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options);
	}
}

export interface BundleValidateOptions {
	json?: boolean;
	checkEnv?: boolean;
}

function formatIssue(issue: CueBundleValidationIssue): string {
	return `  [${issue.code}] ${issue.message}${issue.file ? ` (${issue.file})` : ''}`;
}

/** Human label for where a secret was found, shared by validate and import. */
const SECRET_SOURCE_LABEL = {
	credentials: 'systemd credential',
	'run-secrets': '/run/secrets',
	env: 'env',
} as const;

function formatSecretCheck(check: CueBundleSecretCheck): string {
	const status =
		check.status === 'found'
			? `set (${SECRET_SOURCE_LABEL[check.source!]})`
			: check.status === 'missing'
				? 'NOT SET'
				: `UNUSABLE (${check.problem}${check.path ? `, ${check.path}` : ''})`;
	return `  ${check.name}  ${status}`;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Check a bundle's integrity, completeness, and compatibility with this CLI.
 * Exits 1 when the bundle has errors or cannot be read, 0 when it is valid.
 */
export async function bundleValidate(
	cliVersion: string,
	bundlePath: string,
	options: BundleValidateOptions
): Promise<void> {
	const resolved = resolveCliPath(bundlePath);
	let result: Awaited<
		ReturnType<typeof import('../../main/cue/bundle/cue-bundle-validator').validateCueBundle>
	>;
	try {
		const { validateCueBundle } = await import('../../main/cue/bundle/cue-bundle-validator');
		result = await validateCueBundle(resolved, {
			runningVersion: cliVersion,
			checkEnv: options.checkEnv,
		});
	} catch (error) {
		fail(
			`Could not read bundle ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
			options
		);
	}

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					success: true,
					valid: result.valid,
					errors: result.errors,
					warnings: result.warnings,
					...(result.secrets ? { secrets: result.secrets } : {}),
				},
				null,
				2
			)
		);
	} else {
		const lines = [
			`${result.valid ? 'PASS' : 'FAIL'}  ${resolved}  (${plural(result.errors.length, 'error')}, ${plural(result.warnings.length, 'warning')})`,
		];
		if (result.errors.length > 0) lines.push('Errors:', ...result.errors.map(formatIssue));
		if (result.warnings.length > 0) lines.push('Warnings:', ...result.warnings.map(formatIssue));
		if (result.secrets && result.secrets.length > 0) {
			lines.push('Secrets on this machine:', ...result.secrets.map(formatSecretCheck));
		}
		console.log(lines.join('\n'));
	}
	if (!result.valid) process.exit(ExitCode.GeneralError);
}

export interface BundleInspectOptions {
	json?: boolean;
}

/**
 * Describe a bundle from its manifest and README alone. Nothing else in the
 * archive is inflated, so this is cheap on a large bundle and says nothing
 * about integrity (`bundle validate` does that).
 */
export async function bundleInspect(
	bundlePath: string,
	options: BundleInspectOptions
): Promise<void> {
	const resolved = resolveCliPath(bundlePath);
	let manifest: CueBundleManifest | undefined;
	let readme: string | undefined;
	let problem: string | undefined;
	try {
		const { readZipArchive } = await import('../../main/utils/zip-archive');
		const zip = readZipArchive(resolved, { names: ['manifest.json', 'README.md'] });
		const manifestEntry = zip.getEntry('manifest.json');
		readme = zip.getEntry('README.md')?.getData().toString('utf-8');
		if (!manifestEntry) problem = 'The archive has no manifest.json';
		else manifest = JSON.parse(manifestEntry.getData().toString('utf-8')) as CueBundleManifest;
	} catch (error) {
		problem = `Could not read bundle ${resolved}: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (!manifest) fail(problem ?? 'The archive has no manifest.json', options);

	if (options.json) {
		console.log(JSON.stringify({ success: true, manifest, readme: readme ?? null }, null, 2));
		return;
	}

	const files = Array.isArray(manifest.files) ? manifest.files : [];
	const totalSize = files.reduce((sum, f) => sum + (typeof f.size === 'number' ? f.size : 0), 0);
	const requirements = manifest.requirements ?? { events: [], tools: [], secrets: [] };
	const list = (values: string[] | undefined) => (values?.length ? values.join(', ') : 'none');
	const lines = [
		`${manifest.name} (${manifest.kind === 'maestro-pipeline' ? 'pipeline' : 'agent'} bundle)`,
		`  Format v${manifest.bundleVersion}, exported by Maestro ${manifest.producer?.version ?? 'unknown'}, needs Cue engine ${manifest.minEngineVersion} or newer`,
	];
	if (manifest.createdAt) lines.push(`  Created ${manifest.createdAt}`);
	lines.push(`  ${plural(files.length, 'file')}, ${formatSize(totalSize)}`, '', 'Agents:');
	for (const agent of manifest.agents ?? []) {
		lines.push(`  ${agent.name} (${agent.toolType}) in workspace ${agent.workspace}`);
	}
	lines.push('', 'Workspaces:');
	for (const ws of manifest.workspaces ?? []) {
		const source = ws.source;
		const origin = source?.gitRemote
			? ` from ${source.gitRemote}${source.gitBranch ? ` (${source.gitBranch})` : ''}${source.gitRef ? ` @ ${source.gitRef.slice(0, 12)}` : ''}`
			: '';
		lines.push(`  ${ws.key} (${ws.name})${origin}`);
	}
	lines.push(
		'',
		'Requirements:',
		`  Events:  ${list(requirements.events)}`,
		`  Tools:   ${list(requirements.tools)}`,
		`  Secrets: ${list(requirements.secrets)}`
	);
	if (manifest.warnings?.length) {
		lines.push('', 'Warnings:', ...manifest.warnings.map((w) => `  ${w}`));
	}
	console.log(lines.join('\n'));
}

export interface BundleImportOptions {
	/** `key=path`, one per bundle workspace. */
	workspace?: string[];
	/** `tool=path`, provider binary overrides. */
	agentPath?: string[];
	dataDir?: string;
	dryRun?: boolean;
	force?: boolean;
	rejectShellCommands?: boolean;
	json?: boolean;
}

/** Import error codes that mean the invocation was wrong, not the data. */
const IMPORT_USAGE_CODES: ReadonlySet<CueBundleImportErrorCode> = new Set([
	'INVALID_OPTIONS',
	'WORKSPACE_UNMAPPED',
]);

/**
 * Parse repeatable `name=value` flags. Throws a usage message for a value with
 * no `=`, an empty side, or a name given twice. `resolve` turns the value into
 * the stored form (a CLI path is resolved against the working directory).
 */
function parsePairs(
	values: string[] | undefined,
	flag: string,
	resolve: (value: string) => string
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of values ?? []) {
		const eq = raw.indexOf('=');
		const name = eq > 0 ? raw.slice(0, eq).trim() : '';
		const value = eq > 0 ? raw.slice(eq + 1).trim() : '';
		if (!name || !value) {
			throw new Error(`${flag} expects name=path, got "${raw}"`);
		}
		if (name in out) throw new Error(`${flag} gives "${name}" more than once`);
		out[name] = resolve(value);
	}
	return out;
}

function formatConflict(conflict: CueBundleImportConflict): string {
	return `  [${conflict.kind}] ${conflict.message}`;
}

/**
 * Where an import stands when its plan is printed: a dry run, about to write
 * (printed before the first write), or done.
 */
type ImportPhase = 'dry-run' | 'importing' | 'imported';

/** `Imported pipeline "X" into <dir> (created)`, worded for the phase. */
function importHeadline(plan: CueBundleImportPlan, phase: ImportPhase, viaRunningApp: boolean) {
	const kind = plan.bundle.kind === 'maestro-pipeline' ? 'pipeline' : 'agent';
	const verb = { 'dry-run': 'Would import', importing: 'Importing', imported: 'Imported' }[phase];
	const created = {
		'dry-run': ' (would be created)',
		importing: ' (creating it)',
		imported: ' (created)',
	}[phase];
	return `${verb} ${kind} "${plan.bundle.name}" into ${viaRunningApp ? 'the running Maestro app' : plan.dataDir}${plan.createDataDir ? created : ''}`;
}

function formatShellCommands(commands: CueBundleImportPlan['shellCommands']): string[] {
	return commands.map((c) => `  ${c.workspace} / ${c.subscription}: ${c.command}`);
}

function formatImportPlan(
	plan: CueBundleImportPlan,
	phase: ImportPhase,
	force: boolean,
	viaRunningApp = false
): string {
	const lines = [
		importHeadline(plan, phase, viaRunningApp),
		'',
		'Agents:',
		...plan.agents.map(
			(a) =>
				`  ${a.name} (${a.toolType}) ${a.action === 'create' ? 'new' : 'updated'}, works in ${a.cwd}`
		),
	];
	const count = (action: string) => plan.files.filter((f) => f.action === action).length;
	lines.push(
		'',
		`Files: ${count('create')} new, ${count('overwrite')} overwritten, ${count('unchanged')} unchanged`
	);
	for (const cfg of plan.cueConfigs) {
		const parts = [
			cfg.added.length ? `added ${cfg.added.join(', ')}` : '',
			cfg.replaced.length ? `replaced ${cfg.replaced.join(', ')}` : '',
			cfg.unchanged.length ? `unchanged ${cfg.unchanged.join(', ')}` : '',
		].filter(Boolean);
		lines.push(
			`cue.yaml (${cfg.workspace}): ${parts.join('; ') || 'nothing to add'}${cfg.legacyRemoved ? `; replaces ${cfg.legacyRemoved}` : ''}`
		);
	}
	if (plan.pipeline) lines.push(`Pipeline layout: ${plan.pipeline.name} (${plan.pipeline.action})`);
	for (const p of plan.agentPaths) {
		lines.push(
			`Binary for ${p.toolType}: ${p.path} (${p.action}${p.previous && p.action !== 'unchanged' ? `, was ${p.previous}` : ''})`
		);
	}

	if (plan.shellCommands.length > 0) {
		lines.push(
			'',
			`Shell commands (${plan.shellCommands.length}):`,
			...formatShellCommands(plan.shellCommands)
		);
	}
	const dropped = plan.env.filter((e) => e.dropped.length > 0);
	if (dropped.length > 0) {
		lines.push('', 'Dropped environment variables:');
		for (const e of dropped) lines.push(`  ${e.agentName}: ${e.dropped.join(', ')}`);
	}
	if (plan.secrets.length > 0) {
		lines.push('', 'Secrets:');
		// An agent's declared secrets reach that agent alone at launch, so there
		// is no allowlist advice here: adding one to MAESTRO_SERVER_ENV_ALLOW
		// would hand it to every agent the engine runs.
		for (const secret of plan.secrets) {
			const status = secret.set
				? `set (${secret.source ? SECRET_SOURCE_LABEL[secret.source] : 'env'})`
				: secret.problem
					? `UNUSABLE: ${secret.problem}`
					: 'NOT SET';
			lines.push(`  ${secret.name}  ${status}  (${secret.usedBy.join(', ')})`);
		}
		if (plan.secrets.some((secret) => !secret.set)) {
			lines.push(
				'  Supply each as $CREDENTIALS_DIRECTORY/<NAME> (systemd), /run/secrets/<NAME>, or an environment variable.'
			);
		}
	}
	if (plan.conflicts.length > 0) {
		const heading =
			phase === 'dry-run' || !force
				? 'Conflicts:'
				: phase === 'importing'
					? 'Conflicts (overwriting):'
					: 'Conflicts (overwritten):';
		lines.push('', heading, ...plan.conflicts.map(formatConflict));
		if (phase === 'dry-run') lines.push('  Pass --force to overwrite them.');
	}
	if (plan.warnings.length > 0) {
		lines.push('', 'Warnings:', ...plan.warnings.map((w) => `  ${w}`));
	}
	return lines.join('\n');
}

/**
 * Report an import refusal (from the importer, or from the running app) and
 * exit: 2 for a usage problem, 1 otherwise.
 */
function reportImportFailure(
	code: string,
	message: string,
	details: Record<string, unknown>,
	options: BundleImportOptions
): never {
	const exit = IMPORT_USAGE_CODES.has(code as CueBundleImportErrorCode)
		? ExitCode.InvalidUsage
		: ExitCode.GeneralError;
	if (!options.json) {
		const detail: string[] = [];
		if (code === 'CONFLICTS') {
			detail.push(
				...((details.conflicts as CueBundleImportConflict[] | undefined) ?? []).map(formatConflict),
				'Re-run with --dry-run to see the full plan, or --force to overwrite.'
			);
		} else if (code === 'WORKSPACE_UNMAPPED') {
			const keys = (details.workspaces as string[] | undefined) ?? [];
			detail.push(...keys.map((key) => `  --workspace ${key}=<local folder>`));
		} else if (code === 'SHELL_COMMANDS_REFUSED') {
			const commands =
				(details.shellCommands as
					| Array<{ workspace: string; subscription: string; command: string }>
					| undefined) ?? [];
			detail.push(...formatShellCommands(commands));
		} else if (code === 'BUNDLE_INVALID') {
			const issues = (details.errors as CueBundleValidationIssue[] | undefined) ?? [];
			detail.push(...issues.map(formatIssue));
		}
		console.error(`Error: ${message}`);
		if (detail.length > 0) console.error(detail.join('\n'));
		process.exit(exit);
	}
	fail(message, options, exit, code, details);
}

/**
 * Import a bundle into a data directory and the folders its workspaces map to.
 * With the desktop app running (and no --data-dir), the import goes into the
 * app; otherwise it refuses while a Cue engine or the desktop app runs against
 * that directory. Exit 2 for a usage problem, 1 for any other refusal; the
 * JSON `code` names the exact kind (`CueBundleImportErrorCode`).
 */
export async function bundleImport(
	cliVersion: string,
	bundlePath: string,
	options: BundleImportOptions
): Promise<void> {
	let workspaces: Record<string, string>;
	let agentPaths: Record<string, string>;
	try {
		workspaces = parsePairs(options.workspace, '--workspace', resolveCliPath);
		agentPaths = parsePairs(options.agentPath, '--agent-path', resolveCliPath);
	} catch (error) {
		fail(
			error instanceof Error ? error.message : String(error),
			options,
			ExitCode.InvalidUsage,
			'INVALID_OPTIONS'
		);
	}
	const dataDir = options.dataDir ? resolveCliPath(options.dataDir) : resolveUserDataDir();

	if (shouldGoThroughApp(options)) {
		if (Object.keys(agentPaths).length > 0) {
			fail(
				'--agent-path cannot be used while the Maestro app is running. Set binary paths in Settings, or quit the app first.',
				options,
				ExitCode.InvalidUsage,
				'INVALID_OPTIONS'
			);
		}
		const request: CueBundleImportRequest = {
			bundlePath: resolveCliPath(bundlePath),
			workspaces,
			force: options.force,
			refuseShellCommands: options.rejectShellCommands,
			dryRun: options.dryRun,
		};
		const send = async (req: CueBundleImportRequest) => {
			let outcome: CueBundleImportOutcome;
			try {
				outcome = await viaApp<CueBundleImportOutcome>('cue_bundle_import', req);
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error), options);
			}
			if (!outcome.ok) {
				reportImportFailure(outcome.code, outcome.message, outcome.details ?? {}, options);
			}
			return outcome;
		};
		// The app plans and writes in one call, so the plan is shown first from a
		// dry run of the same request: what it installs, shell commands included,
		// is on screen before anything is written. Skipped when the import is
		// going to refuse its conflicts anyway.
		let preview: CueBundleImportPlan | undefined;
		if (!options.json && !options.dryRun) {
			const planned = await send({ ...request, dryRun: true });
			if (planned.plan.conflicts.length === 0 || options.force) {
				preview = planned.plan;
				console.log(formatImportPlan(preview, 'importing', !!options.force, true));
			}
		}
		const outcome = await send(request);
		if (options.json) {
			console.log(
				JSON.stringify(
					{
						success: true,
						applied: outcome.applied,
						dryRun: !!options.dryRun,
						via: 'app',
						plan: outcome.plan,
					},
					null,
					2
				)
			);
			return;
		}
		if (!preview) {
			console.log(
				formatImportPlan(
					outcome.plan,
					outcome.applied ? 'imported' : 'dry-run',
					!!options.force,
					true
				)
			);
			return;
		}
		console.log(importHeadline(outcome.plan, 'imported', true));
		// The app planned again for the write; say so if the bundle changed between.
		if (JSON.stringify(outcome.plan.shellCommands) !== JSON.stringify(preview.shellCommands)) {
			console.log(
				[
					`The bundle changed after the preview. Shell commands imported (${outcome.plan.shellCommands.length}):`,
					...formatShellCommands(outcome.plan.shellCommands),
				].join('\n')
			);
		}
		return;
	}

	const { importCueBundle, CueBundleImportError } =
		await import('../../main/cue/bundle/cue-bundle-importer');
	let result: Awaited<ReturnType<typeof importCueBundle>>;
	try {
		result = await importCueBundle({
			bundlePath: resolveCliPath(bundlePath),
			dataDir,
			workspaces,
			agentPaths,
			runningVersion: cliVersion,
			dryRun: options.dryRun,
			force: options.force,
			refuseShellCommands: options.rejectShellCommands,
			// The plan, shell commands included, goes out before the first write.
			// The write applies this same plan; it is not planned again.
			onBeforeWrite: options.json
				? undefined
				: (plan) => console.log(formatImportPlan(plan, 'importing', !!options.force)),
		});
	} catch (error) {
		if (!(error instanceof CueBundleImportError)) {
			fail(error instanceof Error ? error.message : String(error), options);
		}
		reportImportFailure(error.code, error.message, error.details, options);
	}

	if (options.json) {
		console.log(
			JSON.stringify(
				{ success: true, applied: result.applied, dryRun: !!options.dryRun, plan: result.plan },
				null,
				2
			)
		);
		return;
	}
	console.log(
		result.applied
			? importHeadline(result.plan, 'imported', false)
			: formatImportPlan(result.plan, 'dry-run', !!options.force)
	);
}
