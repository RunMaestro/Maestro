// Cue pipeline commands - list / get / export / add / replace / remove
// pipeline entries from `cue-pipeline-layout.json`. Goes through the running
// Maestro daemon so layout edits are atomic and don't race with the desktop
// app's own writes.
//
// While the Pipeline Editor is open, the renderer's in-memory state is the
// authoritative source of truth and will overwrite CLI edits on its next
// save. Surface to the user via documentation; we don't gate here.

import * as fs from 'fs';
import { withMaestroClient, type MaestroClient } from '../services/maestro-client';

interface CommonOptions {
	json?: boolean;
}
interface AddOptions extends CommonOptions {
	from: string;
	force?: boolean;
}
interface ReplaceOptions extends CommonOptions {
	from: string;
}
interface RemoveOptions extends CommonOptions {
	force?: boolean;
}

interface PipelineEntry {
	id: string;
	name: string;
	color?: string;
	nodes?: unknown[];
	edges?: unknown[];
}

function readPipelineFile(filePath: string): unknown {
	const raw = fs.readFileSync(filePath, 'utf-8');
	try {
		return JSON.parse(raw);
	} catch (err) {
		throw new Error(
			`Failed to parse ${filePath} as JSON: ${err instanceof Error ? err.message : String(err)}`
		);
	}
}

function reportError(message: string, options: CommonOptions): never {
	if (options.json) {
		console.log(JSON.stringify({ type: 'error', error: message }));
	} else {
		console.error(`Error: ${message}`);
	}
	process.exit(1);
}

async function listPipelines(client: MaestroClient): Promise<PipelineEntry[]> {
	const result = await client.sendCommand<{
		type: string;
		pipelines: PipelineEntry[];
	}>({ type: 'cue_pipeline_list' }, 'cue_pipeline_list_result');
	return result.pipelines ?? [];
}

async function getPipeline(
	client: MaestroClient,
	identifier: string
): Promise<PipelineEntry | null> {
	const result = await client.sendCommand<{
		type: string;
		pipeline: PipelineEntry | null;
	}>({ type: 'cue_pipeline_get', identifier }, 'cue_pipeline_get_result');
	return result.pipeline ?? null;
}

interface MutationOk {
	ok: true;
}
interface MutationErr {
	ok: false;
	code: string;
	message: string;
}
type MutationResultPayload = MutationOk | MutationErr;

async function setPipeline(
	client: MaestroClient,
	identifier: string,
	pipeline: unknown,
	policy: 'add' | 'replace'
): Promise<MutationResultPayload> {
	const result = await client.sendCommand<{
		type: string;
		result: MutationResultPayload;
	}>({ type: 'cue_pipeline_set', identifier, pipeline, policy }, 'cue_pipeline_set_result');
	return result.result;
}

async function removePipeline(
	client: MaestroClient,
	identifier: string
): Promise<MutationResultPayload> {
	const result = await client.sendCommand<{
		type: string;
		result: MutationResultPayload;
	}>({ type: 'cue_pipeline_remove', identifier }, 'cue_pipeline_remove_result');
	return result.result;
}

// ─── Subcommands ────────────────────────────────────────────────────────────

export async function cuePipelineList(options: CommonOptions): Promise<void> {
	try {
		const pipelines = await withMaestroClient(listPipelines);

		if (options.json) {
			console.log(JSON.stringify(pipelines, null, 2));
			return;
		}

		if (pipelines.length === 0) {
			console.log('No pipelines found in cue-pipeline-layout.json.');
			return;
		}

		const lines: string[] = [`Cue Pipelines (${pipelines.length}):\n`];
		for (const p of pipelines) {
			const nodes = Array.isArray(p.nodes) ? p.nodes.length : 0;
			const edges = Array.isArray(p.edges) ? p.edges.length : 0;
			lines.push(`  ${p.name}`);
			lines.push(
				`     id: ${p.id}  |  ${nodes} node${nodes === 1 ? '' : 's'}, ${edges} edge${edges === 1 ? '' : 's'}`
			);
		}
		console.log(lines.join('\n'));
	} catch (error) {
		reportError(error instanceof Error ? error.message : String(error), options);
	}
}

export async function cuePipelineGet(name: string, options: CommonOptions): Promise<void> {
	try {
		const pipeline = await withMaestroClient((client) => getPipeline(client, name));
		if (!pipeline) {
			reportError(`Pipeline "${name}" not found`, options);
		}

		// `get` always emits JSON to stdout - pipelines have no readable
		// non-JSON form, and this output is meant to be consumed by tooling
		// or piped into `add`/`replace --from -`.
		console.log(JSON.stringify(pipeline, null, 2));
	} catch (error) {
		reportError(error instanceof Error ? error.message : String(error), options);
	}
}

/** `export` is just `get` - kept as a separate entry point so the help text
 *  reads naturally for users coming from "I want to back this pipeline up". */
export async function cuePipelineExport(name: string, options: CommonOptions): Promise<void> {
	return cuePipelineGet(name, options);
}

export async function cuePipelineAdd(name: string, options: AddOptions): Promise<void> {
	try {
		if (!options.from) {
			reportError('--from <file> is required', options);
		}
		const pipeline = readPipelineFile(options.from);

		const policy: 'add' | 'replace' = options.force ? 'replace' : 'add';
		const result = await withMaestroClient((client) => setPipeline(client, name, pipeline, policy));

		if (result.ok) {
			if (options.json) {
				console.log(JSON.stringify({ ok: true, identifier: name, policy }));
			} else {
				console.log(`Pipeline "${name}" ${policy === 'add' ? 'added' : 'replaced'}.`);
			}
			return;
		}
		reportError(`${result.message} (${result.code})`, options);
	} catch (error) {
		reportError(error instanceof Error ? error.message : String(error), options);
	}
}

export async function cuePipelineReplace(name: string, options: ReplaceOptions): Promise<void> {
	try {
		if (!options.from) {
			reportError('--from <file> is required', options);
		}
		const pipeline = readPipelineFile(options.from);
		const result = await withMaestroClient((client) =>
			setPipeline(client, name, pipeline, 'replace')
		);

		if (result.ok) {
			if (options.json) {
				console.log(JSON.stringify({ ok: true, identifier: name, policy: 'replace' }));
			} else {
				console.log(`Pipeline "${name}" replaced.`);
			}
			return;
		}
		reportError(`${result.message} (${result.code})`, options);
	} catch (error) {
		reportError(error instanceof Error ? error.message : String(error), options);
	}
}

export async function cuePipelineRemove(name: string, options: RemoveOptions): Promise<void> {
	try {
		const result = await withMaestroClient((client) => removePipeline(client, name));
		if (result.ok) {
			if (options.json) {
				console.log(JSON.stringify({ ok: true, identifier: name }));
			} else {
				console.log(`Pipeline "${name}" removed.`);
			}
			return;
		}
		reportError(`${result.message} (${result.code})`, options);
	} catch (error) {
		reportError(error instanceof Error ? error.message : String(error), options);
	}
}
