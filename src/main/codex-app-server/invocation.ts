// src/main/codex-app-server/invocation.ts

/**
 * Read a `codex exec --json` invocation back out of the args the caller built.
 *
 * The app-server spawner receives the same `ProcessConfig` the exec path would
 * have run, so the turn's settings arrive as exec CLI args assembled by
 * `buildAgentArgs()` / `applyAgentConfigOverrides()` from the agent definition.
 * Parsing them here keeps the transport swap inside the main process, the same
 * way `OpencodeServerSpawner.parseInvocation()` does for OpenCode, and the
 * mapping is the table in `docs/agent-guides/CODEX-APP-SERVER.md`.
 *
 * The parser is a whitelist. An arg it does not know how to carry (a write
 * grant outside full access, an image, a custom flag the user added) makes the
 * whole turn unsupported, so the spawner runs it on `codex exec` instead. Dropping the
 * arg silently would run a turn the user did not configure.
 *
 * On an SSH remote the config's own args are the ssh client's, so the exec turn
 * is read from `config.codexAppServerSsh` instead (see `ssh-launch.ts`).
 */

import type { ProcessConfig } from '../process-manager/types';
import { resolveCodexTransport } from '../../shared/codexTransport';
import { DEFAULT_QUERY_SOURCE } from '../../shared/querySource';

/** `SandboxMode` on `thread/start` / `thread/resume`. */
export type CodexAppServerSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

const SANDBOX_MODES: readonly CodexAppServerSandbox[] = [
	'read-only',
	'workspace-write',
	'danger-full-access',
];

export interface CodexAppServerInvocation {
	/** Thread to resume (`resume <id>`), or undefined to start a new thread. */
	resumeId?: string;
	/** Working directory for the thread: `-C <dir>`, else the spawn cwd. */
	cwd: string;
	/** `-m <model>`. */
	model?: string;
	/**
	 * Sandbox for the thread. Undefined when the exec args named none, so the
	 * thread takes its default from `config.toml` exactly as exec would.
	 */
	sandbox?: CodexAppServerSandbox;
	/** `-c model_reasoning_effort=...`, for `turn/start` `effort`. */
	effort?: string;
	/** `-c model_reasoning_summary=...`, for `turn/start` `summary`. */
	summary?: string;
	/**
	 * Every `-c key=value` override, as `['-c', 'key=value', ...]`. `codex
	 * app-server` takes `-c` itself and parses the value as TOML, so passing
	 * them to the child keeps exec's semantics byte for byte.
	 */
	configArgs: string[];
}

export type CodexAppServerInvocationResult =
	| { ok: true; invocation: CodexAppServerInvocation }
	| { ok: false; reason: string };

/** Flags exec needs that mean nothing to app-server. */
const IGNORED_FLAGS = new Set(['--json', '--skip-git-repo-check']);

/** Strip one layer of TOML string quoting: `"high"` -> `high`. */
function unquoteTomlString(value: string): string {
	const trimmed = value.trim();
	if (
		trimmed.length >= 2 &&
		((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
			(trimmed.startsWith("'") && trimmed.endsWith("'")))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/** `--flag value` or `--flag=value`; returns the value and how many args it used. */
function readFlagValue(
	args: string[],
	index: number,
	names: readonly string[]
): { value: string; consumed: number } | null {
	const arg = args[index];
	for (const name of names) {
		if (arg === name) {
			const value = args[index + 1];
			return value === undefined ? null : { value, consumed: 2 };
		}
		if (name.startsWith('--') && arg.startsWith(`${name}=`)) {
			return { value: arg.slice(name.length + 1), consumed: 1 };
		}
	}
	return null;
}

/**
 * Whether this turn should try app-server at all: a Codex agent that opted in,
 * on a turn a person sent. An Auto Run or Cue turn has nobody to steer it, so it
 * stays on exec. Origin is `querySource`, which every dispatcher claims at the
 * spawn site (absent means a human sent it, see `shared/querySource.ts`).
 */
export function wantsCodexAppServer(
	config: Pick<ProcessConfig, 'toolType' | 'codexTransport' | 'querySource'>
): boolean {
	return (
		resolveCodexTransport(config) === 'app-server' &&
		(config.querySource ?? DEFAULT_QUERY_SOURCE) === 'user'
	);
}

/**
 * The exec turn app-server would carry: its args, working directory and
 * prompt. Locally that is the config itself. On an SSH remote the config holds
 * the ssh client's args, the LOCAL cwd and no prompt (it rides the stdin
 * script), so the planned turn comes from the SSH launch.
 */
function execTurnOf(config: ProcessConfig): { args: string[]; cwd: string; prompt?: string } {
	const ssh = config.codexAppServerSsh;
	return ssh
		? { args: ssh.execArgs, cwd: ssh.cwd, prompt: ssh.prompt }
		: { args: config.args, cwd: config.cwd, prompt: config.prompt };
}

/**
 * Why this spawn cannot run on app-server, or null when it can. Covers the
 * config-level exclusions; the args themselves are checked by
 * `parseCodexAppServerInvocation()`.
 */
export function codexAppServerConfigBlocker(config: ProcessConfig): string | null {
	if (!execTurnOf(config).prompt) return 'no prompt';
	if (config.images && config.images.length > 0) return 'image prompt';
	// An SSH turn runs on app-server only through the launch the spawn handler
	// built for it; the exec wrapper's script cannot be repurposed.
	if ((config.sshRemoteId || config.sshStdinScript) && !config.codexAppServerSsh) {
		return 'SSH remote without an app-server launch';
	}
	if (config.promptAlreadyInArgs) return 'prompt embedded in args';
	return null;
}

export function parseCodexAppServerInvocation(
	config: ProcessConfig
): CodexAppServerInvocationResult {
	const blocker = codexAppServerConfigBlocker(config);
	if (blocker) return { ok: false, reason: blocker };
	const turn = execTurnOf(config);
	return parseCodexExecArgs(turn.args, turn.cwd);
}

/**
 * Read a `codex exec` arg list into an app-server invocation. `cwd` is the
 * thread's directory unless the args name one with `-C`.
 */
export function parseCodexExecArgs(args: string[], cwd: string): CodexAppServerInvocationResult {
	const out: CodexAppServerInvocation = { cwd, configArgs: [] };
	let sawExec = false;
	let bypass = false;
	let sandbox: CodexAppServerSandbox | undefined;
	let writeGrants = 0;

	for (let i = 0; i < args.length; ) {
		const arg = args[i];

		if (arg === 'exec' && !sawExec) {
			sawExec = true;
			i += 1;
			continue;
		}
		if (arg === 'resume' && sawExec && out.resumeId === undefined) {
			const id = args[i + 1];
			if (!id || id.startsWith('-')) return { ok: false, reason: 'resume without a thread id' };
			out.resumeId = id;
			i += 2;
			continue;
		}
		if (IGNORED_FLAGS.has(arg)) {
			i += 1;
			continue;
		}
		if (arg === '--dangerously-bypass-approvals-and-sandbox') {
			bypass = true;
			i += 1;
			continue;
		}

		const cwd = readFlagValue(args, i, ['-C', '--cd']);
		if (cwd) {
			out.cwd = cwd.value;
			i += cwd.consumed;
			continue;
		}

		const sandboxFlag = readFlagValue(args, i, ['-s', '--sandbox']);
		if (sandboxFlag) {
			const mode = sandboxFlag.value as CodexAppServerSandbox;
			if (!SANDBOX_MODES.includes(mode)) {
				return { ok: false, reason: `unknown sandbox mode: ${sandboxFlag.value}` };
			}
			sandbox = mode;
			i += sandboxFlag.consumed;
			continue;
		}

		// A write grant has no app-server field; whether the turn can still run
		// here depends on the sandbox, which is only known after the loop.
		const addDir = readFlagValue(args, i, ['--add-dir']);
		if (addDir) {
			writeGrants += 1;
			i += addDir.consumed;
			continue;
		}

		const model = readFlagValue(args, i, ['-m', '--model']);
		if (model) {
			out.model = model.value;
			i += model.consumed;
			continue;
		}

		const override = readFlagValue(args, i, ['-c', '--config']);
		if (override) {
			const eq = override.value.indexOf('=');
			if (eq <= 0) return { ok: false, reason: `malformed config override: ${override.value}` };
			const key = override.value.slice(0, eq).trim();
			const value = override.value.slice(eq + 1);
			if (key === 'model_reasoning_effort') out.effort = unquoteTomlString(value);
			if (key === 'model_reasoning_summary') out.summary = unquoteTomlString(value);
			out.configArgs.push('-c', override.value);
			i += override.consumed;
			continue;
		}

		return { ok: false, reason: `unsupported argument: ${arg}` };
	}

	if (!sawExec) return { ok: false, reason: 'not an exec invocation' };

	// `--dangerously-bypass-approvals-and-sandbox` nullifies `--sandbox` in exec,
	// so it wins here too.
	out.sandbox = bypass ? 'danger-full-access' : sandbox;
	// `--add-dir` widens a workspace-write sandbox, and app-server has no field to
	// carry it. Under full access it grants nothing the turn does not already
	// have, so dropping it changes nothing; under any other sandbox (or one left
	// to config.toml) the grant matters and only exec can apply it.
	if (writeGrants > 0 && out.sandbox !== 'danger-full-access') {
		return { ok: false, reason: 'write grant (--add-dir) outside full access' };
	}
	// The resume id comes from the args alone, never `config.agentSessionId`:
	// a turn exec would have started fresh must not resume here.
	return { ok: true, invocation: out };
}

/** `SandboxPolicy.type` the server echoes for each sandbox mode we request. */
const ECHOED_SANDBOX_TYPE: Record<CodexAppServerSandbox, string> = {
	'read-only': 'readOnly',
	'workspace-write': 'workspaceWrite',
	'danger-full-access': 'dangerFullAccess',
};

/**
 * Why the thread the server set up does not run under the sandbox this turn
 * asked for, or null when it does (or nothing restrictive was asked for).
 *
 * The `thread/start` and `thread/resume` responses echo the EFFECTIVE `sandbox`
 * as a `SandboxPolicy` object (`{ type: 'readOnly', ... }`). A resumed thread
 * has its own persisted settings, and the request's override is what keeps a
 * read-only turn read-only, so a turn that asked for a restricted sandbox is
 * checked against the echo before its prompt goes out. An echo that is
 * missing, or names anything else, is a mismatch: the safe answer to "I cannot
 * tell which sandbox this runs in" is exec, which applies `--sandbox` itself.
 * Full access is not checked, since anything the server could pick instead is
 * narrower.
 *
 * The echoed `approvalPolicy` is deliberately NOT checked: outside full access
 * the spawner declines every approval request (`answerCodexServerRequest`), so
 * no approval policy can widen what a restricted turn may do, and the check
 * would only send turns to exec for a difference that changes nothing.
 */
export function codexThreadPolicyMismatch(
	invocation: Pick<CodexAppServerInvocation, 'sandbox'>,
	result: unknown
): string | null {
	const requested = invocation.sandbox;
	if (!requested || requested === 'danger-full-access') return null;
	const echo = (result && typeof result === 'object' ? result : {}) as {
		sandbox?: { type?: unknown } | null;
	};
	const sandboxType = echo.sandbox?.type;
	if (sandboxType === ECHOED_SANDBOX_TYPE[requested]) return null;
	return `requested sandbox ${requested}, thread runs ${
		typeof sandboxType === 'string' ? sandboxType : 'an unreported sandbox'
	}`;
}
