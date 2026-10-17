/**
 * What the Maestro model server is started with: its command line, and the
 * presets file that lists the models it serves.
 *
 * The server runs in llama-server's router mode: one process that loads a model
 * when a request names it, in a child process of its own, at most `--models-max`
 * at a time. The presets file (`--models-preset`) is generated from the
 * catalog's installed text models at every start, one section per model:
 *
 *     [qwen3-1.7b-instruct-q4km]
 *     model = /.../models/qwen3-1.7b-instruct-q4km/Qwen3-1.7B-Q4_K_M.gguf
 *     c = 40960
 *     jinja = true
 *
 * The section name is the catalog id. In router mode llama-server makes the
 * section name the model's id, and passes it to the model's process as its
 * `--alias` (an `alias` key in the file is overwritten), so a harness asks for
 * the same id Maestro uses everywhere. `c` is the model's context and `jinja`
 * turns on the model's own chat template, which tool calls need.
 *
 * The presets dialect has no quoting: a `;` or `#` anywhere in a value starts a
 * comment, and a line break ends the value. A model path holding one is refused
 * by name. Written as it is, the server would open a truncated path.
 *
 * Everything here but `collectServerModels` is pure.
 */

import {
	allLocalModels,
	localModelGgufFile,
	localModelProjectorFile,
} from '../../../shared/local-models/model-catalog';
import {
	MODEL_SERVER_AGENT_MIN_CONTEXT,
	MODEL_SERVER_BIND_HOSTS,
	MODEL_SERVER_NAME,
	type ModelServerBind,
} from '../../../shared/local-models/model-server';
import type { LocalModelEntry } from '../../../shared/local-models/types';
import { ModelServerError } from '../errors';
import { isInstalled, modelFilePath } from '../model-store';

/** One model the server offers. */
export interface ServerModelPreset {
	/** The catalog id: the section name, and the model name a request sends. */
	id: string;
	/** Absolute path of the GGUF the server opens. */
	modelPath: string;
	/** Absolute path of the vision projector loaded beside the GGUF. Only a model that reads images has one. */
	mmprojPath?: string;
	/** The context the server runs the model at (`c`). */
	contextSize: number;
}

/**
 * The context the server gives a model: the catalog's `defaultContext`. A model
 * without one runs at the agent floor: the server is for agent harnesses, and
 * less than that fails their first prompt.
 */
export function serverContextSize(entry: LocalModelEntry): number {
	return entry.defaultContext ?? MODEL_SERVER_AGENT_MIN_CONTEXT;
}

/** Whether the server can serve a catalog entry at all: a text model llama.cpp opens. */
export function isServerModel(entry: LocalModelEntry): boolean {
	return localModelGgufFile(entry) !== undefined;
}

/**
 * Every installed text model, as the server offers it: the curated catalog in
 * catalog order, then the models the user added.
 */
export async function collectServerModels(): Promise<ServerModelPreset[]> {
	const models: ServerModelPreset[] = [];
	for (const entry of allLocalModels()) {
		const gguf = localModelGgufFile(entry);
		if (!gguf || !(await isInstalled(entry.id))) continue;
		const projector = localModelProjectorFile(entry);
		models.push({
			id: entry.id,
			modelPath: modelFilePath(entry.id, gguf.path),
			...(projector ? { mmprojPath: modelFilePath(entry.id, projector.path) } : {}),
			contextSize: serverContextSize(entry),
		});
	}
	return models;
}

/** A character the presets dialect reads as syntax, named for the error. */
function iniBreakingCharacter(value: string, extra: readonly string[] = []): string | null {
	for (const [character, name] of [
		[';', 'a semicolon'],
		['#', 'a "#"'],
		['\n', 'a line break'],
		['\r', 'a line break'],
		...extra.map((character) => [character, `"${character}"`]),
	] as const) {
		if (value.includes(character)) return name;
	}
	if (value !== value.trim()) return 'leading or trailing spaces';
	return null;
}

function refusePreset(model: string, problem: string): never {
	throw new ModelServerError(
		`The ${MODEL_SERVER_NAME} cannot serve "${model}": ${problem}`,
		'preset-invalid'
	);
}

/** The presets file for a list of models. Throws `preset-invalid` for a value it cannot carry. */
export function renderModelServerPresets(models: readonly ServerModelPreset[]): string {
	const lines = [
		'; Written by Maestro each time the model server starts. Edits are replaced.',
		'version = 1',
	];
	for (const model of models) {
		const idProblem = iniBreakingCharacter(model.id, ['[', ']']);
		if (idProblem) {
			refusePreset(model.id, `its id contains ${idProblem}, which the presets file cannot hold.`);
		}
		// `*` is the section the presets file reads as "every model".
		if (model.id === '' || model.id === '*') {
			refusePreset(model.id, 'that is not a model id the presets file can hold.');
		}
		for (const filePath of [model.modelPath, model.mmprojPath]) {
			const pathProblem = filePath === undefined ? null : iniBreakingCharacter(filePath);
			if (pathProblem) {
				refusePreset(
					model.id,
					`its file path contains ${pathProblem}, which the presets file cannot hold. Move Maestro's data folder to a path without it.`
				);
			}
		}
		if (!Number.isInteger(model.contextSize) || model.contextSize <= 0) {
			refusePreset(
				model.id,
				`its context size (${model.contextSize}) is not a positive whole number.`
			);
		}
		lines.push(
			'',
			`[${model.id}]`,
			`model = ${model.modelPath}`,
			...(model.mmprojPath ? [`mmproj = ${model.mmprojPath}`] : []),
			`c = ${model.contextSize}`,
			'jinja = true'
		);
	}
	return `${lines.join('\n')}\n`;
}

/**
 * The server's environment: Maestro's, without a single `LLAMA_*` variable, and
 * with `LLAMA_CACHE` set to a folder of the server's own.
 *
 * llama-server reads every one of its options from a `LLAMA_ARG_*` variable when
 * the command line does not set it, so a variable left in a user's shell would
 * configure Maestro's server: `LLAMA_ARG_MODEL` takes it out of router mode,
 * `LLAMA_API_KEY` adds a key nobody chose, `LLAMA_ARG_MODELS_DIR` serves a folder
 * of someone else's models. Router mode also lists every model in the cache, so
 * the cache is an empty folder: the server serves the presets and nothing else.
 */
export function modelServerEnvironment(
	base: NodeJS.ProcessEnv,
	cacheDir: string
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(base)) {
		// Upper-cased: Windows variable names are not case-sensitive.
		if (value === undefined || key.toUpperCase().startsWith('LLAMA_')) continue;
		env[key] = value;
	}
	env.LLAMA_CACHE = cacheDir;
	return env;
}

export interface ModelServerArgsOptions {
	bind: ModelServerBind;
	port: number;
	presetsPath: string;
	maxModels: number;
	/** The file holding the API key. Required in both modes; see `ModelServerBind`. */
	apiKeyFile: string;
}

/**
 * The server's arguments. Throws `key-required` without a key file: the server
 * is never started without one, and on a network bind that would hand every
 * machine on the network the models with no key at all.
 *
 *   --no-webui   it serves harnesses; the chat page is surface nobody asked for
 *   --offline    it serves the files in the presets and never downloads one
 */
export function buildModelServerArgs(options: ModelServerArgsOptions): string[] {
	if (typeof options.apiKeyFile !== 'string' || options.apiKeyFile.trim() === '') {
		throw new ModelServerError(
			options.bind === 'network'
				? `The ${MODEL_SERVER_NAME} will not listen on the network (${MODEL_SERVER_BIND_HOSTS.network}) without an API key. It was not started.`
				: `The ${MODEL_SERVER_NAME} is never started without an API key. It was not started.`,
			'key-required'
		);
	}
	return [
		'--host',
		MODEL_SERVER_BIND_HOSTS[options.bind],
		'--port',
		String(options.port),
		'--models-preset',
		options.presetsPath,
		'--models-max',
		String(options.maxModels),
		'--api-key-file',
		options.apiKeyFile,
		'--no-webui',
		'--offline',
	];
}
