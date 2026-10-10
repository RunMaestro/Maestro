/**
 * LoginTerminal - run one login command in an embedded PTY.
 *
 * The shared half of every "sign in without leaving Maestro" surface: the
 * provider re-auth dialog (`ReauthModal`) and the GitHub CLI login behind Send
 * Feedback (`GitHubLoginModal`). It spawns a real terminal-tab shell, types the
 * command once the shell is alive, scrapes the sign-in URL into a copy button,
 * and reports how the session ended. What to log into, and what to do when it
 * succeeds, stays with the caller.
 *
 * The PTY is a real terminal tab process (`process:spawnTerminalTab`), so a
 * TUI, a device-code prompt, and an SSH remote all behave exactly as they do in
 * a terminal tab. The routing key must carry `-terminal-`: that is what makes
 * PtySpawner forward raw output for xterm.js. Callers build it with
 * {@link loginPtySessionId}.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { XTerminal, type XTerminalHandle } from './XTerminal';
import { useSettingsStore } from '../stores/settingsStore';
import { notifyToast } from '../stores/notificationStore';
import { generateId } from '../utils/ids';
import { findLoginUrl } from '../utils/loginUrl';
import { isWindowsPlatform } from '../utils/platformUtils';
import { safeClipboardWrite } from '../utils/clipboard';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
import { logger } from '../utils/logger';
import type { Theme } from '../types';

export type LoginTerminalStatus = 'starting' | 'running' | 'failed' | 'exited';

export interface LoginTerminalSshConfig {
	enabled: boolean;
	remoteId: string | null;
	workingDirOverride?: string;
}

/** Where and how the login shell is started. Read once, when the shell spawns. */
export interface LoginTerminalSpawn {
	shell?: string;
	shellArgs?: string;
	shellEnvVars?: Record<string, string>;
	sshConfig?: LoginTerminalSshConfig;
	/** Local working directory. Ignored over SSH, where the remote home is safer. */
	cwd?: string;
	toolType?: string;
	customEnvVars?: Record<string, string>;
}

export interface LoginTerminalProps {
	theme: Theme;
	/** PTY routing key, from {@link loginPtySessionId}. A new key starts a new shell. */
	ptySessionId: string;
	/** The exact line typed into the shell. */
	commandLine: string;
	spawn: LoginTerminalSpawn;
	onStatusChange?: (status: LoginTerminalStatus, error: string | null) => void;
	/** The shell exited, with its exit code. */
	onExit?: (code: number) => void;
	/** Prefix for this surface's `data-testid`s (`reauth-copy-url`). */
	testIdPrefix?: string;
}

/**
 * How long to wait for the shell's first byte before typing the login command
 * anyway. Generous because it has to cover an SSH handshake to a cold remote;
 * the normal path fires on the prompt long before this.
 */
const SILENT_SHELL_FALLBACK_MS = 8000;

/**
 * How much login output to keep for URL scanning. A login screen is a few KB;
 * this is generous enough to survive a redraw while keeping the buffer from
 * growing for as long as the dialog stays open.
 */
const OUTPUT_SCAN_LIMIT = 64_000;

/**
 * A PTY routing key for a login shell. Two parts are load-bearing:
 *   - `-terminal-` makes PtySpawner forward raw (unstripped) output for
 *     xterm.js, and makes useAgentExitListener ignore the process.
 *   - the caller's `prefix` keeps the part before `-terminal-` from equalling
 *     any agent id, so TerminalView (which claims every `{sessionId}-terminal-*`
 *     exit for its own tabs) never mistakes a login shell for a closed tab.
 */
export function loginPtySessionId(prefix: string): string {
	return `${prefix}-terminal-${generateId()}`;
}

/**
 * Shell a local login runs in.
 *
 * On Windows the configured default may be WSL, and that is the one shell a
 * login must NOT use: Maestro spawns agents and `gh` as native Windows
 * processes (nothing goes through `wsl.exe`), so a login inside WSL writes
 * credentials to the WSL home directory that the native process never reads.
 * The login would appear to succeed and fix nothing. A remote login is
 * unaffected - its shell is the SSH remote's own.
 */
export function resolveLoginShell(
	defaultShell: string | undefined,
	remote: boolean
): string | undefined {
	if (remote) return defaultShell;
	if (isWindowsPlatform() && defaultShell?.trim().toLowerCase() === 'wsl') return 'powershell';
	return defaultShell;
}

export function LoginTerminal({
	theme,
	ptySessionId,
	commandLine,
	spawn,
	onStatusChange,
	onExit,
	testIdPrefix = 'login',
}: LoginTerminalProps) {
	const fontFamily = useSettingsStore((s) => s.fontFamily);
	const fontSize = useSettingsStore((s) => s.fontSize);

	const terminalRef = useRef<XTerminalHandle | null>(null);
	// Bumped per spawn so a superseded attempt (StrictMode remount, a new key)
	// cannot type its login command into a shell that is being replaced.
	const spawnGenerationRef = useRef(0);
	// The login command, held until the shell proves it is alive. See below.
	const pendingCommandRef = useRef<{ ptySessionId: string; command: string } | null>(null);
	// Latched the first time the command is actually typed for this shell. Once
	// the user is inside a login the app must not put another keystroke on that
	// PTY: they may be halfway through a device code or a password, and a
	// replayed command line lands in the middle of whatever they were entering.
	const typedForRef = useRef<string | null>(null);
	const commandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	/** Sign-in URL scraped from the login output, once the provider prints one. */
	const [loginUrl, setLoginUrl] = useState<string | null>(null);
	/** Rolling tail of login output, scanned for that URL. */
	const outputRef = useRef('');

	// Callbacks are read through refs so a parent re-render never restarts the
	// shell or drops an event.
	const onStatusChangeRef = useRef(onStatusChange);
	onStatusChangeRef.current = onStatusChange;
	const onExitRef = useRef(onExit);
	onExitRef.current = onExit;
	const statusRef = useRef<LoginTerminalStatus>('starting');
	const report = useCallback((status: LoginTerminalStatus, error: string | null = null) => {
		statusRef.current = status;
		onStatusChangeRef.current?.(status, error);
	}, []);

	// Type the login command in, once the shell is actually there to receive it.
	//
	// Not sent straight after the spawn resolves: over SSH the spawn resolves as
	// soon as the local `ssh` client is running, seconds before the remote shell
	// exists, and anything typed into that gap is dropped - which is exactly how
	// a remote login came up as an empty box. So the command is held until the
	// PTY produces its first byte (the prompt), with a timeout fallback for a
	// shell that prints nothing at all.
	const flushPendingCommand = useCallback(() => {
		const pending = pendingCommandRef.current;
		if (!pending) return;
		pendingCommandRef.current = null;
		if (commandTimerRef.current) {
			clearTimeout(commandTimerRef.current);
			commandTimerRef.current = null;
		}
		if (typedForRef.current === pending.ptySessionId) return;
		typedForRef.current = pending.ptySessionId;
		// CR, not LF: this is what a real Enter key sends (see the terminal
		// keyboard handler), and it is the only one that submits reliably on
		// Windows - ConPTY passes LF through as Ctrl+J, which PSReadLine does not
		// treat as "run this line", so a PowerShell login would sit there untyped.
		// A Unix PTY maps CR to NL for us, so this is correct on every platform.
		void window.maestro.process.write(pending.ptySessionId, `${pending.command}\r`).catch(() => {
			// A failed write surfaces as the process exiting; nothing to add here.
		});
	}, []);

	useEffect(() => {
		outputRef.current = '';
		setLoginUrl(null);
		return window.maestro.process.onData((dataSessionId: string, data: string) => {
			if (dataSessionId !== ptySessionId) return;
			flushPendingCommand();

			// Watch the stream for the sign-in URL. A login URL is hundreds of
			// characters, the TUI soft-wraps it across rows, and mouse-tracking
			// TUIs swallow the drag that would select it - so reading it off the
			// screen is not a realistic option for the user.
			outputRef.current = `${outputRef.current}${data}`.slice(-OUTPUT_SCAN_LIMIT);
			const found = findLoginUrl(outputRef.current);
			if (found) setLoginUrl((prev) => (prev === found ? prev : found));
		});
	}, [ptySessionId, flushPendingCommand]);

	/**
	 * Everything the spawn below needs, refreshed every render but deliberately
	 * NOT a dependency of it.
	 *
	 * These values are objects and arrays out of the settings and session stores
	 * (`shellEnvVars`, `shellArgs`, the SSH config, the agent's own env), and
	 * their IDENTITY churns whenever either store rehydrates from main, even
	 * when nothing about them changed. As effect dependencies that churn tore
	 * down a live login shell and started a fresh one mid-flow, which is how the
	 * login command came to be typed a second time over whatever the user was
	 * entering. A login shell is started once per key and then left alone; a
	 * settings write is never a reason to restart it.
	 */
	const spawnInputsRef = useRef({ commandLine, spawn });
	spawnInputsRef.current = { commandLine, spawn };

	// Spawn the login shell, and tear it down when it is replaced or unmounted.
	//
	// Spawn and kill live in ONE effect on purpose. Split across two, React's
	// StrictMode remount (cleanup, then re-run) killed the shell that the first
	// pass had just started while a `spawnStarted` guard blocked the second pass
	// from starting another - leaving a dead or orphaned PTY that nobody ever
	// typed into. The guard is therefore a generation counter that the cleanup
	// resets, so a remount always ends up with exactly one live shell.
	useEffect(() => {
		const { commandLine: command, spawn: inputs } = spawnInputsRef.current;
		const generation = ++spawnGenerationRef.current;
		let disposed = false;
		report('starting');

		void window.maestro.process
			.spawnTerminalTab({
				sessionId: ptySessionId,
				// The login runs wherever the shell lands (the remote's home dir over
				// SSH). It needs no project directory, and guessing one risks a `cd`
				// that fails and kills the session before the login can run.
				cwd: inputs.sshConfig?.enabled ? '' : inputs.cwd || '',
				shell: inputs.shell || undefined,
				shellArgs: inputs.shellArgs,
				shellEnvVars: inputs.shellEnvVars,
				toolType: inputs.toolType,
				sessionCustomEnvVars: inputs.customEnvVars,
				sessionSshRemoteConfig: inputs.sshConfig,
			})
			.then((result) => {
				// A superseded generation's shell is already being replaced; writing
				// to it would type the login into a PTY nobody is watching.
				if (disposed || spawnGenerationRef.current !== generation) return;
				if (!result.success) {
					report(
						'failed',
						inputs.sshConfig?.enabled
							? 'The SSH remote could not be reached. Check that the remote is enabled and online.'
							: 'A shell could not be started for the login flow.'
					);
					return;
				}
				report('running');
				pendingCommandRef.current = { ptySessionId, command };
				commandTimerRef.current = setTimeout(flushPendingCommand, SILENT_SHELL_FALLBACK_MS);
			})
			.catch((err: unknown) => {
				if (disposed || spawnGenerationRef.current !== generation) return;
				logger.error('[LoginTerminal] Failed to spawn login terminal', undefined, err);
				report(
					'failed',
					err instanceof Error ? err.message : 'The login terminal failed to start.'
				);
			});

		return () => {
			disposed = true;
			pendingCommandRef.current = null;
			if (commandTimerRef.current) {
				clearTimeout(commandTimerRef.current);
				commandTimerRef.current = null;
			}
			// Never leave a login shell running behind a closed dialog. Re-spawning
			// under the same key is safe: ProcessManager kills the predecessor.
			void window.maestro.process.kill(ptySessionId).catch(() => {
				// Already gone - that is the desired end state either way.
			});
		};
	}, [ptySessionId, flushPendingCommand, report]);

	// The login shell exiting means the flow is over, one way or the other. A
	// shell that dies without printing anything (a dropped SSH transport, a
	// remote with no such binary) would otherwise leave an empty box with no
	// explanation, so say so in the terminal itself.
	useEffect(() => {
		return window.maestro.process.onExit((exitSessionId: string, code: number) => {
			if (exitSessionId !== ptySessionId) return;
			pendingCommandRef.current = null;
			terminalRef.current?.write('\r\n\x1b[2m[the login session ended]\x1b[0m\r\n');
			if (statusRef.current !== 'failed') report('exited');
			onExitRef.current?.(code);
		});
	}, [ptySessionId, report]);

	const handleFocusTerminal = useCallback(() => {
		terminalRef.current?.focus();
	}, []);

	const handleCopyLoginUrl = useCallback(async () => {
		if (!loginUrl) return;
		const copied = await safeClipboardWrite(loginUrl);
		if (copied) {
			flashCopiedToClipboard(loginUrl, 'Login URL Copied');
		} else {
			notifyToast({
				color: 'red',
				title: 'Could not copy',
				message: 'The login URL could not be written to the clipboard.',
			});
		}
	}, [loginUrl]);

	return (
		<>
			{/* The login printed a sign-in URL. Surfacing it as a button is the only
			    practical way to get at it: it is far too long to retype, it is
			    soft-wrapped across terminal rows, and a mouse-tracking TUI swallows
			    the drag that would select it. */}
			{loginUrl && (
				<div className="flex items-center gap-2 shrink-0">
					<button
						type="button"
						onClick={handleCopyLoginUrl}
						className="inline-flex items-center gap-1.5 px-2 py-1 rounded border hover:bg-white/5 transition-colors text-xs shrink-0"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						data-testid={`${testIdPrefix}-copy-url`}
					>
						<Copy className="w-3.5 h-3.5" />
						<span>Copy Login URL</span>
					</button>
					<span
						className="text-xs min-w-0 truncate select-text"
						style={{ color: theme.colors.textDim }}
						title={loginUrl}
					>
						{loginUrl}
					</span>
				</div>
			)}

			<div
				className="flex-1 min-h-0 rounded border overflow-hidden"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				onClick={handleFocusTerminal}
			>
				<XTerminal
					ref={(handle) => {
						terminalRef.current = handle;
					}}
					sessionId={ptySessionId}
					theme={theme}
					fontFamily={fontFamily}
					fontSize={Math.round(fontSize * 0.85)}
				/>
			</div>
		</>
	);
}
