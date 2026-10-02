// Bundle commands - pack a Cue pipeline or a single agent into a portable,
// deterministic zip (`src/shared/cue-bundle-types.ts`), then check or describe
// one.
//
// Reads Maestro's data directory straight off disk, so it works with the
// desktop app closed. The exporter, validator, and zip reader are loaded with a
// dynamic `import()` so archiver, js-yaml, and the Cue config reader stay out of
// every other command's startup path.

import * as fs from 'fs';
import { resolveUserDataDir } from '../../shared/userDataDir';
import { resolveAgentId } from '../services/storage';
import { resolveCliPath } from '../utils/parse';
import { ExitCode } from '../exit-codes';
import { formatSize } from '../../shared/formatters';
import type { CueBundleManifest } from '../../shared/cue-bundle-types';
import type { CueBundleValidationIssue } from '../../main/cue/bundle/cue-bundle-validator';

export interface BundleExportOptions {
	agent?: string;
	pipeline?: string;
	output?: string;
	allowInlineSecrets?: boolean;
	dataDir?: string;
	createdAt?: string;
	json?: boolean;
}

function fail(message: string, options: { json?: boolean }, code = ExitCode.GeneralError): never {
	if (options.json) {
		console.log(JSON.stringify({ success: false, error: message }));
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
		if (!fs.existsSync(dataDir)) {
			fail(`Maestro data directory not found: ${dataDir}`, options);
		}

		const { exportCueBundle, readSessions } =
			await import('../../main/cue/bundle/cue-bundle-exporter');

		let agentId: string | undefined;
		let agentName: string | undefined;
		if (options.agent) {
			const sessions = readSessions(dataDir);
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
