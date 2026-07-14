/**
 * Per-provider metadata for account multiplexing (Virtuosos).
 *
 * Single source of truth for how each multiplexable provider isolates
 * account state on disk. Used by the main-process setup/injection layer
 * and by the renderer to gate UI affordances (create flow, selector).
 *
 * Parity matrix (verified 2026-07-12):
 * - claude-code: full parity via CLAUDE_CONFIG_DIR
 * - codex: full parity via CODEX_HOME (auth.json lives in CODEX_HOME)
 * - opencode: full parity via XDG_DATA_HOME (auth at $XDG_DATA_HOME/opencode/auth.json).
 *   Honored on Windows too: opencode resolves its data dir through the npm
 *   xdg-basedir package, which reads the env var with NO platform branch and
 *   falls back to <home>/.local/share on every OS - it never uses
 *   %APPDATA%/%LOCALAPPDATA% (verified 2026-07-14 against sst/opencode
 *   packages/core/src/global.ts + sindresorhus/xdg-basedir index.js)
 * - gemini-cli: NO config-dir override exists (google-gemini/gemini-cli#2815 open);
 *   import/observe only, single default dir
 * - factory-droid: no documented override for ~/.factory, credentials in OS keyring;
 *   import/observe only, single default dir
 */

import type { MultiplexableAgent } from './account-types';
import { isWindows } from './platformDetection';

export interface AccountProviderMeta {
	agentType: MultiplexableAgent;
	displayName: string;
	/**
	 * Env var that relocates the provider's config/auth dir for a spawned process.
	 * null = the provider cannot be relocated, so per-account isolation
	 * (create flow, spawn injection, auto-switching) is unavailable.
	 */
	envVar: string | null;
	/** Home-dir prefix for Maestro-managed account dirs (e.g. '.claude-' -> ~/.claude-work). null = no create flow. */
	dirPrefix: string | null;
	/** The provider's default single config dir name (e.g. '.claude'), used for discovery and credential sync. */
	baseDirName: string;
	/** Auth files checked relative to the account dir; first found wins. */
	authFiles: string[];
	/** The credential file (relative to the account dir) that login writes and sync copies. null = keyring/unsupported. */
	credentialFile: string | null;
	/** Shell command template to authenticate an account dir. null = no CLI login for isolated dirs. */
	buildLoginCommand: ((configDir: string, binary?: string) => string) | null;
	/** Binary + args used by automatic auth recovery. null = recovery must instruct manual login. */
	loginSpawn: { binary: string; args: string[] } | null;
	/** Whether the "Create New Virtuoso" flow can provision isolated dirs for this provider. */
	supportsCreate: boolean;
	/** Short user-facing note shown when supportsCreate is false. */
	createUnsupportedReason?: string;
}

/**
 * Build the user-facing manual login command for an account dir.
 * POSIX shells accept an inline `VAR="value" cmd` prefix; neither cmd.exe nor
 * PowerShell does, so Windows gets the PowerShell form
 * (`$env:VAR='value'; cmd`) - PowerShell is Maestro's preferred Windows shell
 * for agent execution (see getWindowsShellForAgentExecution). Single quotes
 * keep the dir literal in PowerShell; embedded single quotes are doubled.
 */
function buildEnvLoginCommand(
	envVar: string,
	dir: string,
	binary: string,
	loginArgs: string
): string {
	if (isWindows()) {
		return `$env:${envVar}='${dir.replace(/'/g, "''")}'; ${binary} ${loginArgs}`;
	}
	return `${envVar}="${dir}" ${binary} ${loginArgs}`;
}

export const ACCOUNT_PROVIDER_META: Record<MultiplexableAgent, AccountProviderMeta> = {
	'claude-code': {
		agentType: 'claude-code',
		displayName: 'Claude Code',
		envVar: 'CLAUDE_CONFIG_DIR',
		dirPrefix: '.claude-',
		baseDirName: '.claude',
		authFiles: ['.claude.json', '.credentials.json'],
		credentialFile: '.credentials.json',
		buildLoginCommand: (dir, binary = 'claude') =>
			buildEnvLoginCommand('CLAUDE_CONFIG_DIR', dir, binary, 'login'),
		loginSpawn: { binary: 'claude', args: ['login'] },
		supportsCreate: true,
	},
	codex: {
		agentType: 'codex',
		displayName: 'OpenAI Codex',
		envVar: 'CODEX_HOME',
		dirPrefix: '.codex-',
		baseDirName: '.codex',
		authFiles: ['auth.json', 'config.toml'],
		credentialFile: 'auth.json',
		buildLoginCommand: (dir, binary = 'codex') =>
			buildEnvLoginCommand('CODEX_HOME', dir, binary, 'login'),
		loginSpawn: { binary: 'codex', args: ['login'] },
		supportsCreate: true,
	},
	opencode: {
		agentType: 'opencode',
		displayName: 'OpenCode',
		envVar: 'XDG_DATA_HOME',
		dirPrefix: '.opencode-',
		baseDirName: '.opencode',
		// XDG_DATA_HOME layout puts auth at <dir>/opencode/auth.json; legacy layouts checked after
		authFiles: ['opencode/auth.json', 'auth.json', 'config.json'],
		credentialFile: 'opencode/auth.json',
		buildLoginCommand: (dir, binary = 'opencode') =>
			buildEnvLoginCommand('XDG_DATA_HOME', dir, binary, 'auth login'),
		loginSpawn: { binary: 'opencode', args: ['auth', 'login'] },
		supportsCreate: true,
	},
	'gemini-cli': {
		agentType: 'gemini-cli',
		displayName: 'Gemini CLI',
		envVar: null,
		dirPrefix: null,
		baseDirName: '.gemini',
		authFiles: ['oauth_creds.json', 'google_accounts.json'],
		credentialFile: null,
		buildLoginCommand: null,
		loginSpawn: null,
		supportsCreate: false,
		createUnsupportedReason:
			'Gemini CLI cannot relocate its config dir yet (google-gemini/gemini-cli#2815). Use Discover to import the default ~/.gemini account.',
	},
	'factory-droid': {
		agentType: 'factory-droid',
		displayName: 'Factory Droid',
		envVar: null,
		dirPrefix: null,
		baseDirName: '.factory',
		authFiles: ['auth.json', 'settings.json'],
		credentialFile: null,
		buildLoginCommand: null,
		loginSpawn: null,
		supportsCreate: false,
		createUnsupportedReason:
			'Factory Droid stores credentials in the OS keyring and has no config-dir override. Use Discover to import the default ~/.factory account.',
	},
};

/** Providers in display order (creatable first). */
export const ACCOUNT_PROVIDER_ORDER: MultiplexableAgent[] = [
	'claude-code',
	'codex',
	'opencode',
	'gemini-cli',
	'factory-droid',
];

/** Look up metadata; unknown/legacy profiles (no agentType) resolve to claude-code. */
export function getAccountProviderMeta(agentType?: string | null): AccountProviderMeta {
	return (
		ACCOUNT_PROVIDER_META[(agentType ?? 'claude-code') as MultiplexableAgent] ??
		ACCOUNT_PROVIDER_META['claude-code']
	);
}

/** Providers whose spawns can be routed to isolated account dirs. */
export function isMultiplexingCapable(agentType?: string | null): boolean {
	const meta = ACCOUNT_PROVIDER_META[(agentType ?? '') as MultiplexableAgent];
	return !!meta?.envVar;
}

/**
 * Infer the provider a config dir belongs to from its basename
 * (e.g. ~/.codex-work -> codex, ~/.gemini -> gemini-cli).
 * Falls back to claude-code for unrecognized paths (legacy dirs).
 */
export function inferProviderFromDir(configDir: string): MultiplexableAgent {
	const basename = configDir.split(/[\\/]/).filter(Boolean).pop() ?? '';
	for (const meta of Object.values(ACCOUNT_PROVIDER_META)) {
		if (meta.dirPrefix && basename.startsWith(meta.dirPrefix)) return meta.agentType;
	}
	for (const meta of Object.values(ACCOUNT_PROVIDER_META)) {
		if (basename === meta.baseDirName) return meta.agentType;
	}
	return 'claude-code';
}
