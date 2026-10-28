/**
 * How Maestro asks node-llama-cpp for a backend, and how it names the one it got.
 *
 * Shared by every caller of `getLlama()` (the runtime self-test and the local
 * text-generation path) so the diagnostic loads the backend exactly the way the
 * feature will. A self-test that called `getLlama()` with different options
 * would prove a load path nobody uses.
 *
 * Structural types only: importing node-llama-cpp's own types would put the
 * package back into the static import graph, which is what `native-loader.ts`
 * exists to prevent.
 */

/**
 * The `getLlama()` options.
 *
 * - `build: 'never'`: node-llama-cpp's default outside Electron is `'auto'`,
 *   which answers a prebuilt binary that fails to load by downloading llama.cpp
 *   and compiling it with cmake. On a user's machine that is minutes of silent
 *   CPU and a toolchain they may not have; the runtime download already carries
 *   the prebuilt binary for this platform, and if THAT does not load the honest
 *   answer is a named failure, not a compile.
 * - `skipDownload: true`: the same rule for the llama.cpp source fetch.
 * - `progressLogs: false`: nothing is being built, so there is nothing to log.
 */
export const LLAMA_GET_OPTIONS = Object.freeze({
	build: 'never',
	skipDownload: true,
	progressLogs: false,
} as const);

/**
 * The `resolveChatWrapper()` options for every local text turn: no reasoning.
 *
 * `qwen.thoughts: 'discourage'` is the Qwen family's own no-thinking format (an
 * empty thought written before the reply, what its template does for
 * `enable_thinking=false`, and what the model server path sends as
 * `chat_template_kwargs`). Without it the Qwen3.5 format OPENS every reply
 * inside a thought, and node-llama-cpp files the first generated token there:
 * a grammar reply came back without its opening `{` and parsed as nothing, on
 * every task (found on real hardware, 2026-10-12). A token budget of zero
 * (`budgets.thoughtTokens`) closes the thought one token too late to help.
 *
 * Keyed by wrapper type, so it changes nothing for a model of another family.
 */
export const LLAMA_CHAT_WRAPPER_OPTIONS = Object.freeze({
	customWrapperSettings: Object.freeze({
		qwen: Object.freeze({ thoughts: 'discourage' }),
	}),
} as const);

/** The part of node-llama-cpp's `Llama` instance a backend report reads. */
export interface LlamaBackendInfo {
	/** `'metal' | 'cuda' | 'vulkan'`, or `false` for CPU only. */
	gpu?: unknown;
	/** `'prebuilt'` or `'localBuild'`. */
	buildType?: unknown;
}

const GPU_LABELS: Record<string, string> = {
	metal: 'Metal',
	cuda: 'CUDA',
	vulkan: 'Vulkan',
};

/**
 * The backend as a person reads it: `Metal`, `CUDA`, `Vulkan`, or `CPU`.
 *
 * An unknown GPU string is passed through rather than mapped to CPU, because a
 * future node-llama-cpp backend reported as "CPU" would send someone chasing a
 * performance bug that is not there.
 */
export function llamaBackendLabel(llama: LlamaBackendInfo): string {
	const gpu = llama.gpu;
	if (gpu === false || gpu === undefined || gpu === null) return 'CPU';
	if (typeof gpu === 'string') return GPU_LABELS[gpu] ?? gpu;
	return String(gpu);
}
