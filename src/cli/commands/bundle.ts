// Bundle commands - pack a Cue pipeline or a single agent into a portable,
// deterministic zip (`src/shared/cue-bundle-types.ts`).
//
// Reads Maestro's data directory straight off disk, so it works with the
// desktop app closed. The exporter is loaded with a dynamic `import()` so
// archiver, js-yaml, and the Cue config reader stay out of every other
// command's startup path.

import * as fs from 'fs';
import { resolveUserDataDir } from '../../shared/userDataDir';
import { resolveAgentId } from '../services/storage';
import { resolveCliPath } from '../utils/parse';
import { ExitCode } from '../exit-codes';

export interface BundleExportOptions {
	agent?: string;
	pipeline?: string;
	output?: string;
	allowInlineSecrets?: boolean;
	dataDir?: string;
	createdAt?: string;
	json?: boolean;
}

function fail(message: string, options: BundleExportOptions, code = ExitCode.GeneralError): never {
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
