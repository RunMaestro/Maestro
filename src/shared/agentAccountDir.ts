/**
 * Which account dir one agent's processes run under: where its provider reads
 * and writes that agent's transcripts (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, ...).
 *
 * A session browser must read the agent's OWN account. The provider resumes a
 * session only from the config dir it was started with, so listing another
 * account's pool offers sessions the agent cannot open.
 *
 * Store-free, so the main process and the CLI resolve it the same way;
 * each caller reads its own stores and passes the layers in. Uses Node's `path`,
 * so it is for main and CLI only, never the renderer.
 */

import path from 'path';
import { canonicalJson } from './canonicalJson';
import type { NativeSessionBinding } from './maestro-lib/agents/providerSwap';
import { sha256Hex } from './maestro-lib/grok/host-seams';
import { isWindows } from './platformDetection';
import type { SshRemoteConfig } from './types';
import { isBlankEnvValue } from './agentEnvironment';
import { expandTilde } from './pathUtils';
import { effectiveAgentCustomEnvVars, getProviderProfileConfig } from './providerProfiles';

export interface AgentAccountDirInput {
	toolType: string;
	/** The agent's own env vars. */
	customEnvVars?: Record<string, string>;
	/** Whether the agent runs on an SSH remote. */
	sshRemote?: boolean;
}

export interface AgentAccountDirLayers {
	/** Provider-level env vars (Settings -> Agents). */
	agentLevelEnvVars?: Record<string, string>;
	/** Settings -> Environment. */
	globalShellEnvVars?: Record<string, string>;
	/** The env the host process was launched with. */
	env?: Record<string, string | undefined>;
	homeDir: string;
}

/**
 * Same precedence as `buildChildProcessEnv`: the agent's own env vars (or the
 * provider-level set it inherits, which REPLACES rather than layers), then
 * Settings -> Environment, then the host env, then the provider default.
 * A blank at the winning layer unsets the variable, selecting the provider
 * default rather than falling through to another account in a lower layer.
 *
 * An SSH agent carries only its custom vars to the remote host, so only that
 * layer counts; the value is a remote path and is returned as is (no `~`
 * expansion on this machine), and `undefined` with none set so the caller
 * keeps its remote default. `undefined` too for a provider with no account dir.
 */
export function resolveAgentAccountDir(
	agent: AgentAccountDirInput,
	layers: AgentAccountDirLayers
): string | undefined {
	const config = getProviderProfileConfig(agent.toolType);
	if (!config) return undefined;

	const usable = (value: unknown): value is string =>
		typeof value === 'string' && !isBlankEnvValue(value);
	const custom = effectiveAgentCustomEnvVars(agent.customEnvVars, layers.agentLevelEnvVars)[
		config.envVar
	];

	if (agent.sshRemote) return usable(custom) ? custom.trim() : undefined;

	// Select before checking for blanks, matching the launch environment's
	// merge-then-unset rule. A blank override must not revive another account.
	const chosen =
		custom ?? layers.globalShellEnvVars?.[config.envVar] ?? layers.env?.[config.envVar];
	if (!usable(chosen)) return path.join(layers.homeDir, config.defaultSubdir);
	return path.resolve(expandTilde(chosen.trim(), layers.homeDir));
}

/**
 * The opaque reference of one provider account, as a native session binding
 * carries it (`NativeSessionBinding.accountRef`): the provider and the
 * normalized REAL account directory, digested. A path never crosses the
 * binding and a directory NAME never acts as one. Callers pass the directory
 * they already resolved and realpath'd (`resolveAgentAccountDir`, then the
 * host's realpath), local or remote.
 */
export function nativeAccountRef(providerId: string, accountDir: string): string {
	const normalized = accountDir.replace(/\\/g, '/').replace(/\/+$/, '');
	return sha256Hex(canonicalJson({ providerId, accountDir: normalized }));
}

/** Host-owned observations; none may read credentials or historical content. */
export interface GrokLaunchScopePorts {
	local: {
		homedir(): string;
		realpath(directory: string): Promise<string>;
		stat(directory: string): Promise<{ isDirectory(): boolean }>;
		/** Kept synchronous to preserve the admission-to-spawn recheck boundary. */
		realpathSync(directory: string): string;
		isExpectedError(error: unknown): boolean;
		/** Stable executing installation, never a process/runtime epoch or config alias. */
		installationId(): string;
	};
	remote: {
		/**
		 * Return the complete validated directory observation, including its path
		 * and environment evidence. Rechecks compare the entire receipt, not just
		 * the canonical paths named by this minimal structural port.
		 */
		observe(
			cwd: string,
			remote: SshRemoteConfig,
			launch: { env: NodeJS.ProcessEnv; nativeCwd?: string }
		): Promise<{
			success: boolean;
			data?: { cwd: { canonicalPath: string }; account: { canonicalPath: string } };
			error?: string;
			errorCode?: string;
		}>;
		/**
		 * The stable installation identity of `remote`, attested by the host, or
		 * `undefined` when this host cannot attest one. An SSH config alias is not
		 * a host identity: without an answer the scope stays unknown, and an
		 * unknown scope refuses native resume.
		 */
		qualify(remote: SshRemoteConfig): Promise<string | undefined>;
		isExpectedError(error?: string): boolean;
	};
}

/** Observe directories only; never open account credentials or historical output. */
export async function observeGrokLaunchScope(
	config: { cwd: string },
	remote: SshRemoteConfig | null,
	env: NodeJS.ProcessEnv,
	args: readonly string[],
	ports: GrokLaunchScopePorts
) {
	const unknown: {
		scope: Extract<NativeSessionBinding, { state: 'unknown' }>;
		recheck?: never;
	} = { scope: { version: 1, state: 'unknown', reason: 'unobserved' } };
	let recheck: (() => boolean | Promise<boolean>) | undefined;
	let cwd: string;
	let account: string;
	let identity: string;
	if (remote) {
		// The selectors have already passed grokLaunchArgsProblem. Observe the
		// native argument separately from the shell cd: relative/tilde CLI values
		// are literal and can select a different directory after that first cd.
		const cwdIndex = args.findIndex((arg) => arg === '--cwd' || arg.startsWith('--cwd='));
		const nativeCwd =
			cwdIndex < 0
				? undefined
				: args[cwdIndex] === '--cwd'
					? args[cwdIndex + 1]
					: args[cwdIndex].slice('--cwd='.length);
		const observe = () => ports.remote.observe(config.cwd, remote, { env, nativeCwd });
		const qualify = () => ports.remote.qualify(structuredClone(remote));
		const endpoint = await qualify();
		if (!endpoint || !endpoint.trim() || /[\x00-\x1f\x7f]/.test(endpoint)) return unknown;
		const observed = await observe();
		if (!observed.success || !observed.data) {
			if (!observed.errorCode && !ports.remote.isExpectedError(observed.error))
				throw new Error(observed.error || 'Grok launch path observation failed.');
			return unknown;
		}
		if ((await qualify()) !== endpoint) return unknown;
		cwd = observed.data.cwd.canonicalPath;
		account = observed.data.account.canonicalPath;
		// The shared binding/account wire normalizes these spellings. Do not label
		// a literal native directory as a different account to make it representable.
		if (cwd !== cwd.trim() || account !== account.trim() || /\\/.test(cwd + account))
			return unknown;
		identity = endpoint;
		recheck = async () => {
			if ((await qualify()) !== endpoint) return false;
			const next = await observe();
			if (!next.success && !next.errorCode && !ports.remote.isExpectedError(next.error))
				throw new Error(next.error || 'Grok launch path observation failed.');
			if ((await qualify()) !== endpoint) return false;
			return next.success && canonicalJson(next.data) === canonicalJson(observed.data);
		};
	} else {
		const homeDir = (isWindows() ? env.USERPROFILE : env.HOME) || ports.local.homedir();
		// Resolve a relative provider root in the CHILD's cwd, not the desktop's.
		if (!path.isAbsolute(config.cwd)) return unknown;
		const launchCwd = path.resolve(expandTilde(config.cwd));
		const rawAccount = env.GROK_HOME;
		const nativeHome = isWindows() ? env.USERPROFILE : env.HOME;
		if (!rawAccount && nativeHome !== undefined && !path.isAbsolute(nativeHome)) return unknown;
		if (rawAccount !== undefined && rawAccount !== rawAccount.trim()) return unknown;
		const accountDir = resolveAgentAccountDir(
			{
				toolType: 'grok',
				customEnvVars: !rawAccount ? {} : { GROK_HOME: path.resolve(launchCwd, rawAccount) },
			},
			{ homeDir, env: {} }
		);
		if (!accountDir) return unknown;
		try {
			[cwd, account] = await Promise.all([
				ports.local.realpath(launchCwd),
				ports.local.realpath(accountDir),
			]);
			const stats = await Promise.all([ports.local.stat(cwd), ports.local.stat(account)]);
			if (!stats.every((stat) => stat.isDirectory())) return unknown;
		} catch (error) {
			if (!ports.local.isExpectedError(error)) throw error;
			return unknown;
		}
		recheck = () => {
			try {
				return (
					ports.local.realpathSync(launchCwd) === cwd &&
					ports.local.realpathSync(accountDir) === account
				);
			} catch (error) {
				if (!ports.local.isExpectedError(error)) throw error;
				return false;
			}
		};
		identity = ports.local.installationId();
	}
	return {
		recheck,
		scope: Object.freeze({
			version: 1 as const,
			state: 'bound' as const,
			provider: 'grok' as const,
			accountRef: nativeAccountRef('grok', account),
			cwd,
			host: Object.freeze({ kind: remote ? ('ssh' as const) : ('local' as const), identity }),
		}),
	};
}
