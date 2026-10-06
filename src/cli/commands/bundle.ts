// Bundle commands - pack a Cue pipeline or a single agent into a portable,
// deterministic zip (`src/shared/cue-bundle-types.ts`), check or describe one,
// and import one into a data directory.
//
// Reads Maestro's data directory straight off disk, so it works with the
// desktop app closed (import REQUIRES it closed). The exporter, validator,
// importer, and zip reader are loaded with a dynamic `import()` so archiver,
// js-yaml, and the Cue config reader stay out of every other command's startup
// path.

import { assertUserDataDirExists, resolveUserDataDir } from '../../shared/userDataDir';
import { resolveAgentId } from '../services/storage';
import { readSessionsStoreFile } from '../../main/stores/sessions-store-file';
import { resolveCliPath } from '../utils/parse';
import { ExitCode } from '../exit-codes';
import { formatSize } from '../../shared/formatters';
import type { CueBundleManifest } from '../../shared/cue-bundle-types';
import type { CueBundleValidationIssue } from '../../main/cue/bundle/cue-bundle-validator';
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
	json?: boolean;
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

		const { exportCueBundle } = await import('../../main/cue/bundle/cue-bundle-exporter');

		let agentId: string | undefined;
		let agentName: string | undefined;
		if (options.agent) {
			const { sessions } = readSessionsStoreFile(dataDir);
			agentId = resolveAgentId(options.agent, sessions);
			agentName = sessions.find((s) => s.id === agentId)?.name;
		}

		const outputPath = resolveCliPath(
			options.output ?? defaultOutputName(options.pipeline ?? agentName ?? 'bundle')
		);

		const result = await exportCueBundle({
			dataDir,
			agentId,
			pipeline: options.pipeline,
			outputPath,
			allowInlineSecrets: options.allowInlineSecrets,
			createdAt: options.createdAt,
			producerVersion: cliVersion,
		});

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
				{ success: true, valid: result.valid, errors: result.errors, warnings: result.warnings },
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

function formatImportPlan(plan: CueBundleImportPlan, applied: boolean, force: boolean): string {
	const kind = plan.bundle.kind === 'maestro-pipeline' ? 'pipeline' : 'agent';
	const lines = [
		`${applied ? 'Imported' : 'Would import'} ${kind} "${plan.bundle.name}" into ${plan.dataDir}${plan.createDataDir ? (applied ? ' (created)' : ' (would be created)') : ''}`,
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
		lines.push('', `Shell commands (${plan.shellCommands.length}):`);
		for (const c of plan.shellCommands) {
			lines.push(`  ${c.workspace} / ${c.subscription}: ${c.command}`);
		}
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
		const sourceLabel = {
			credentials: 'systemd credential',
			'run-secrets': '/run/secrets',
			env: 'env',
		};
		for (const secret of plan.secrets) {
			const status = secret.set
				? `set (${secret.source ? sourceLabel[secret.source] : 'env'})`
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
		lines.push(
			'',
			applied && force ? 'Conflicts (overwritten):' : 'Conflicts:',
			...plan.conflicts.map(formatConflict)
		);
		if (!applied) lines.push('  Pass --force to overwrite them.');
	}
	if (plan.warnings.length > 0) {
		lines.push('', 'Warnings:', ...plan.warnings.map((w) => `  ${w}`));
	}
	return lines.join('\n');
}

/**
 * Import a bundle into a data directory and the folders its workspaces map to.
 * Refuses while a Cue engine or the desktop app runs against that directory.
 * Exit 2 for a usage problem, 1 for any other refusal; the JSON `code` names
 * the exact kind (`CueBundleImportErrorCode`).
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
		});
	} catch (error) {
		if (!(error instanceof CueBundleImportError)) {
			fail(error instanceof Error ? error.message : String(error), options);
		}
		const exit = IMPORT_USAGE_CODES.has(error.code) ? ExitCode.InvalidUsage : ExitCode.GeneralError;
		if (!options.json) {
			const detail: string[] = [];
			if (error.code === 'CONFLICTS') {
				detail.push(
					...(error.details.conflicts as CueBundleImportConflict[]).map(formatConflict),
					'Re-run with --dry-run to see the full plan, or --force to overwrite.'
				);
			} else if (error.code === 'WORKSPACE_UNMAPPED') {
				const keys = error.details.workspaces as string[];
				detail.push(...keys.map((key) => `  --workspace ${key}=<local folder>`));
			} else if (error.code === 'SHELL_COMMANDS_REFUSED') {
				const commands = error.details.shellCommands as Array<{
					workspace: string;
					subscription: string;
					command: string;
				}>;
				detail.push(...commands.map((c) => `  ${c.workspace} / ${c.subscription}: ${c.command}`));
			} else if (error.code === 'BUNDLE_INVALID') {
				const issues = (error.details.errors as CueBundleValidationIssue[] | undefined) ?? [];
				detail.push(...issues.map(formatIssue));
			}
			console.error(`Error: ${error.message}`);
			if (detail.length > 0) console.error(detail.join('\n'));
			process.exit(exit);
		}
		fail(error.message, options, exit, error.code, error.details);
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
	console.log(formatImportPlan(result.plan, result.applied, !!options.force));
}
