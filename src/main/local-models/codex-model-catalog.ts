/**
 * Codex's model catalog for an agent that runs on a Local Models source.
 *
 * Codex knows the models in its own catalog. For any other name it builds a
 * fallback entry (`model_info_from_slug` in `codex-rs/models-manager`), warns
 * "Model metadata for `<model>` not found" on every turn, and caps the window
 * at the fallback's `max_context_window` of 272,000, whatever
 * `model_context_window` says. `-c model_catalog_json=<path>` hands Codex an
 * entry for the model instead.
 *
 * The entry IS the fallback, field for field, with two changes: the window is
 * the target's, and the model is not marked unknown. The instructions are
 * Codex's own `prompt.md` (vendored), so the model is prompted exactly as the
 * fallback prompts it. Fields Codex's deserializer would default to something
 * other than the fallback's value are written out.
 *
 * Measured 2026-11-12 with Codex CLI 0.167.2 on Ollama
 * (`deepseek-v4.1-flash:cloud`): no warning, the session's base instructions
 * byte-identical to the fallback's, a 1,000,000 window at 950,000 effective
 * (was 258,400), and a tool call and an answer as before.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runOnArgPathProblem } from '../../shared/local-models/run-on';
import { sha256Hex } from '../../shared/maestro-lib/grok/host-seams';
import { atomicWriteFile } from '../utils/atomic-json-store';
import { CODEX_BASE_INSTRUCTIONS } from './vendor/codex-base-instructions';

/** Codex's fallback percentage of the window it lets a turn use. */
const CODEX_EFFECTIVE_CONTEXT_PERCENT = 95;

/** Codex's fallback tool-output truncation. */
const CODEX_FALLBACK_TRUNCATION_BYTES = 10_000;

/** Where catalogs are written. One file per distinct catalog, shared by every launch. */
export function defaultCodexModelCatalogDir(): string {
	return path.join(os.tmpdir(), 'maestro-run-on');
}

/** Codex's fallback entry for `model`, with the target's window. */
export function codexModelCatalogEntry(model: string, contextTokens: number) {
	return {
		slug: model,
		display_name: model,
		description: null,
		supported_reasoning_levels: [],
		shell_type: 'unified_exec',
		visibility: 'none',
		supported_in_api: true,
		priority: 99,
		availability_nux: null,
		upgrade: null,
		model_messages: { instructions_template: CODEX_BASE_INSTRUCTIONS },
		include_skills_usage_instructions: false,
		include_plugin_usage_instructions: false,
		// Codex's deserializer defaults this one to true; the fallback has false.
		include_apps_usage_instructions: false,
		supports_reasoning_summary_parameter: true,
		default_reasoning_summary: 'auto',
		support_verbosity: false,
		default_verbosity: null,
		apply_patch_tool_type: null,
		web_search_tool_type: 'text',
		truncation_policy: { mode: 'bytes', limit: CODEX_FALLBACK_TRUNCATION_BYTES },
		// Both: `model_context_window` is clamped to `max_context_window`.
		context_window: contextTokens,
		max_context_window: contextTokens,
		effective_context_window_percent: CODEX_EFFECTIVE_CONTEXT_PERCENT,
		experimental_supported_tools: [],
	};
}

/** The catalog file's text: one entry, for the one model the launch runs on. */
export function codexModelCatalog(model: string, contextTokens: number): string {
	return JSON.stringify({ models: [codexModelCatalogEntry(model, contextTokens)] });
}

export type CodexModelCatalogWrite = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Write the catalog for one launch and say where it is. The file is named by
 * its content, so launches on the same model and window share one, and a file
 * already there is not written again. A catalog that cannot be written, or
 * whose path could not go on Codex's command line, comes back as a reason: the
 * caller launches without it (Codex's fallback), never refuses the turn.
 */
export async function writeCodexModelCatalog(
	model: string,
	contextTokens: number,
	dir: string = defaultCodexModelCatalogDir()
): Promise<CodexModelCatalogWrite> {
	const text = codexModelCatalog(model, contextTokens);
	const filePath = path.join(dir, `codex-${sha256Hex(text).slice(0, 16)}.json`);
	const problem = runOnArgPathProblem(filePath);
	if (problem)
		return { ok: false, reason: `the catalog path ${filePath} cannot be passed: ${problem}` };
	try {
		if (await fileExists(filePath)) return { ok: true, path: filePath };
		await fs.mkdir(dir, { recursive: true });
		await atomicWriteFile(filePath, text);
	} catch (error) {
		return {
			ok: false,
			reason: `the catalog could not be written to ${filePath}: ${(error as Error).message}`,
		};
	}
	return { ok: true, path: filePath };
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}
