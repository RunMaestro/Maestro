/**
 * Provider Auth Login PTY
 *
 * Spawns the interactive login command for ONE credential identity into a PTY the
 * recovery modal renders. Everything the probe layer does in the background
 * (`auth-probe.ts`), this does in front of the user and with a terminal attached.
 *
 * Three rules hold here, and each one exists because breaking it produces a
 * successful-looking flow that repairs nothing:
 *
 * 1. **The identity's env, never the app's ambient env.** A login against
 *    `.claude-smash` when the blocked account is `.claude-gmail` writes a fresh
 *    token into the wrong config directory, and the user finds out at the next
 *    prompt. The env is not re-derived here: {@link collectAuthTargets} is the
 *    same function the probe pass uses, so both sides answer "which account is
 *    this" identically.
 * 2. **The far machine's login for a far machine's credential.** An identity
 *    whose host is `ssh:<remote>` is logged in ON that remote through
 *    `wrapSpawnWithSsh`. An unresolvable remote is a hard failure, never a local
 *    fallback - same rule as the probe and the CLI spawner.
 * 3. **A synthetic process id, never an agent's.** See
 *    {@link isLoginRunSessionId}: login output must not reach any agent's
 *    transcript, and a spawn under a live agent's id would also kill that agent.
 *
 * Lifecycle: the PTY is killed when the modal closes, when the user re-runs the
 * command ({@link stopAuthLogin} on both paths), and on app quit - the process is
 * registered in the ProcessManager map, so `killAll()` in the quit handler
 * reaches it like any other.
 */

import * as os from 'os';

import {
	isLoginRunSessionId,
	extractLoginEmail,
	resolveLoginCommand,
	type LoginCommandOptions,
} from '../../../shared/providerAuth';
import type { ProcessManager } from '../../process-manager/ProcessManager';
import type { AgentConfigsData, MaestroSettings, SessionsData } from '../../stores/types';
import { getSnapshot } from '../../stores/providerAuthStore';
import { logger } from '../../utils/logger';
import { createSshRemoteStoreAdapter, getSshRemoteConfig } from '../../utils/ssh-remote-resolver';
import { wrapSpawnWithSsh } from '../../utils/ssh-spawn-wrapper';
import type { SshRemoteConfig } from '../../../shared/types';
import { getAgentDefinition } from '../definitions';
import type { AgentDetector } from '../detector';
import { collectAuthTargets, resolveProviderBinaryPath } from './auth-startup';
import type Store from 'electron-store';

const LOG_CONTEXT = '[AuthLogin]';

/**
 * PTY geometry used when the renderer has not measured its terminal yet. xterm's
 * fit addon resizes the PTY on its first layout pass, so this only shapes the
 * banner a CLI prints before that lands.
 */
const DEFAULT_LOGIN_COLS = 100;
const DEFAULT_LOGIN_ROWS = 30;

export interface AuthLoginDeps {
	sessionsStore: Pick<Store<SessionsData>, 'get'>;
	agentConfigsStore: Pick<Store<AgentConfigsData>, 'get'>;
	settingsStore: Pick<Store<MaestroSettings>, 'get'>;
	getAgentDetector: () => AgentDetector | null;
	getProcessManager: () => ProcessManager | null;
}

export interface StartAuthLoginRequest {
	/** {@link CredentialIdentity.key} of the account being repaired. */
	identityKey: string;
	/** Process id to stream under, from `buildLoginRunSessionId()`. */
	runSessionId: string;
	cols?: number;
	rows?: number;
	/** claude-code: bill against Anthropic Console instead of a subscription. */
	preferConsole?: boolean;
	/** claude-code: force the SSO flow. */
	sso?: boolean;
}

export interface StartAuthLoginResult {
	/** False means nothing was spawned; {@link error} says what to tell the user. */
	started: boolean;
	runSessionId: string;
	/**
	 * The command line as spawned, for the modal's "Show command" reveal. Main is
	 * authoritative about it: a renderer that resolved its own copy could show one
	 * command while a different one runs.
	 */
	commandLine?: string;
	/** Note from {@link resolveLoginCommand} (device-code flow, provider picker). */
	note?: string;
	/** True when the login is running on an SSH remote rather than this machine. */
	remote?: boolean;
	/**
	 * Human name of that remote, for the modal's "you are signing in on X" copy.
	 * The renderer only has the remote's id (from `identity.host`), and an id is
	 * not what the user called the machine.
	 */
	remoteLabel?: string;
	pid?: number;
	/** User-facing reason the login could not start. */
	error?: string;
}

/** Fail with a reason the modal can render verbatim. */
function failure(runSessionId: string, error: string): StartAuthLoginResult {
	return { started: false, runSessionId, error };
}

/**
 * Name one SSH remote the way a user would recognize it: their own label, with
 * the address that actually gets dialed in parentheses so two remotes named
 * "dev" are still told apart.
 */
export function describeSshRemote(config: SshRemoteConfig): string {
	const address = config.username ? `${config.username}@${config.host}` : config.host;
	return config.name && config.name !== address ? `${config.name} (${address})` : address;
}

/**
 * Start the login command for one credential identity in a PTY.
 *
 * Never throws: every failure comes back as `started: false` plus a sentence the
 * modal shows next to the terminal. A login that cannot start must say why, not
 * leave an empty black box on screen.
 */
export async function startAuthLogin(
	deps: AuthLoginDeps,
	request: StartAuthLoginRequest
): Promise<StartAuthLoginResult> {
	const { identityKey, runSessionId } = request;

	// Rule 3. A renderer-supplied id that is not login-shaped would let a bug
	// spawn over a live agent's process and stream login output into its tab.
	if (!isLoginRunSessionId(runSessionId)) {
		logger.warn('Refusing to start a login under a non-login process id', LOG_CONTEXT, {
			identityKey,
			runSessionId,
		});
		return failure(runSessionId, 'Internal error: the login process id was malformed.');
	}

	const processManager = deps.getProcessManager();
	if (!processManager) {
		return failure(runSessionId, 'Maestro is still starting up. Try again in a moment.');
	}
	const agentDetector = deps.getAgentDetector();
	if (!agentDetector) {
		return failure(runSessionId, 'Maestro has not finished detecting installed agents yet.');
	}

	// Rule 1: the SAME resolution the probe pass runs, not a second derivation.
	// `manual` so an SSH identity and an agent nobody opened this week are both
	// still reachable - the user is here asking for this specific account.
	const target = collectAuthTargets({
		sessionsStore: deps.sessionsStore,
		agentConfigsStore: deps.agentConfigsStore,
		settingsStore: deps.settingsStore,
		mode: 'manual',
		now: Date.now(),
		homeDir: os.homedir(),
	}).get(identityKey);

	if (!target) {
		return failure(
			runSessionId,
			'No agent uses this account any more, so Maestro cannot tell which environment to sign in with.'
		);
	}

	const { identity } = target;
	const loginOptions: LoginCommandOptions = {
		...(request.preferConsole ? { preferConsole: true } : {}),
		...(request.sso ? { sso: true } : {}),
		// Pre-fills the login page for a user with several accounts. Read from the
		// stored snapshot here rather than accepted from the renderer, so the
		// address that lands on screen is the one that actually gets used.
		...(() => {
			const email = extractLoginEmail(getSnapshot(identityKey));
			return email ? { email } : {};
		})(),
	};
	const login = resolveLoginCommand(identity, loginOptions);
	if (!login) {
		return failure(
			runSessionId,
			`Signing in cannot repair this credential (${identity.label}). See the guidance above.`
		);
	}

	// Resolve the binary the same way the probe does, so the login repairs the
	// installation the agent actually runs: the agent's own `customPath` first,
	// then the far host's bare binary name for a remote identity, else local
	// detection. Only a LOCAL identity is gated on local detection - a remote one
	// is resolved on the far side.
	const isRemote = !!target.sshRemoteConfig;
	const binaryPath =
		target.binaryPath ??
		(isRemote
			? (getAgentDefinition(identity.provider)?.binaryName ?? null)
			: await resolveProviderBinaryPath(agentDetector, identity.provider));
	if (!binaryPath) {
		return failure(
			runSessionId,
			isRemote
				? // Nothing about this is local: the login would run on the remote host,
					// so telling the user to install a CLI here sends them to the wrong
					// machine.
					`Maestro does not know what to run for ${identity.provider} on this remote, so it cannot start the login there.`
				: `The ${identity.provider} CLI was not found on this machine, so Maestro cannot run its login command.`
		);
	}

	let command = binaryPath;
	let args = login.args;
	let cwd = target.cwd;
	let customEnvVars: Record<string, string> | undefined = target.env;
	let remoteLabel: string | undefined;

	if (target.sshRemoteConfig) {
		// Rule 2. The user put this agent on another machine; running the login
		// here would write a token into THIS machine's config directory and report
		// success for an account that is still broken.
		try {
			const sshStore = createSshRemoteStoreAdapter(deps.settingsStore);
			// Same resolution `wrapSpawnWithSsh` runs, read here only for the name to
			// put on screen. A remote that does not resolve leaves the label unset and
			// the wrap below fails the whole spawn, so the modal never names a machine
			// nothing was run on.
			const resolved = getSshRemoteConfig(sshStore, {
				sessionSshConfig: target.sshRemoteConfig,
			});
			if (resolved.config) remoteLabel = describeSshRemote(resolved.config);
			const wrapped = await wrapSpawnWithSsh(
				{
					command,
					args,
					cwd,
					customEnvVars: target.env,
					agentBinaryName: getAgentDefinition(identity.provider)?.binaryName,
				},
				target.sshRemoteConfig,
				sshStore
			);
			if (!wrapped.sshRemoteUsed) {
				return failure(
					runSessionId,
					'This account lives on an SSH remote that could not be resolved. Maestro will not sign in locally instead - fix the remote in Settings and try again.'
				);
			}
			command = wrapped.command;
			args = wrapped.args;
			cwd = wrapped.cwd;
			customEnvVars = wrapped.customEnvVars;
		} catch (error) {
			logger.warn('Failed to wrap a login command for SSH', LOG_CONTEXT, {
				identityKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return failure(runSessionId, 'Could not build the SSH command for this remote account.');
		}
	}

	const spawn = processManager.spawn({
		sessionId: runSessionId,
		// The provider, not `'terminal'`: a terminal spawn launches the user's
		// login shell and applies only the global shell vars, which would drop the
		// identity's `CLAUDE_CONFIG_DIR` and sign in to the default account.
		toolType: identity.provider,
		cwd,
		command,
		args,
		// No `prompt`, so `shouldUsePty()` routes this to PtySpawner. An OAuth flow
		// draws a TUI and reads keystrokes; a pipe would hang it.
		requiresPty: true,
		// The id is deliberately not terminal-shaped (rule 3), so the raw-output
		// pass-through has to be asked for explicitly or xterm receives the login
		// screen with its escape sequences already stripped.
		rawPtyOutput: true,
		// Rule 1: layered over the base env by `buildChildProcessEnv`, so PATH and
		// friends survive while the credential-selecting vars are exactly the ones
		// the blocked agents spawn with.
		...(customEnvVars ? { customEnvVars } : {}),
		cols: request.cols ?? DEFAULT_LOGIN_COLS,
		rows: request.rows ?? DEFAULT_LOGIN_ROWS,
		//
		// $BROWSER IS DELIBERATELY LEFT ALONE HERE.
		//
		// The two other places Maestro runs a provider CLI - `auth-probe.ts` and
		// `claude-usage-sampler.ts` - both set `BROWSER=/usr/bin/true` on the child
		// env, because those are unattended background samplers and an OAuth window
		// popping open on a timer is a bug (see the Claude token-refresh tab hunt).
		// This call site is the exact inverse: the user pressed a button whose
		// entire purpose is to open the browser. Inheriting the neutralizer would
		// make the flow print a URL to a terminal and then silently swallow the
		// launch, which reads as "the login is broken". So the login PTY takes the
		// ambient `BROWSER` and nothing overrides it.
	});

	if (!spawn.success) {
		return failure(
			runSessionId,
			'The login command could not be started. Check that the CLI runs from your own terminal.'
		);
	}

	logger.info('Started a provider login PTY', LOG_CONTEXT, {
		identityKey,
		provider: identity.provider,
		runSessionId,
		remote: isRemote,
		pid: spawn.pid,
	});

	return {
		started: true,
		runSessionId,
		// The path is intentionally not shown: the modal's reveal is meant to be
		// pasted into a terminal, where the bare binary name is what the user has.
		commandLine: [login.command, ...login.args].join(' '),
		...(login.note ? { note: login.note } : {}),
		...(isRemote ? { remote: true } : {}),
		...(remoteLabel ? { remoteLabel } : {}),
		pid: spawn.pid,
	};
}

/**
 * Kill a login PTY. Returns false when nothing was running under that id, which
 * is the normal case for a modal closed before its spawn landed.
 *
 * Guarded by the same id check as {@link startAuthLogin} so this can never be
 * turned into a "kill any agent by id" primitive.
 */
export function stopAuthLogin(
	getProcessManager: () => ProcessManager | null,
	runSessionId: string
): boolean {
	if (!isLoginRunSessionId(runSessionId)) {
		logger.warn('Refusing to stop a non-login process id', LOG_CONTEXT, { runSessionId });
		return false;
	}
	return getProcessManager()?.kill(runSessionId) ?? false;
}
