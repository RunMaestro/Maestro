// Detect an existing default omp setup and copy its declarative CONFIG (never
// credentials or state) into the isolated Maestro profile, so `mae` inherits the
// user's omp settings on first run.
//
// Layout (see omp config-usage.md): the default base is `~/.omp/agent`; a named
// profile relocates everything to `~/.omp/profiles/<name>/agent` and sees only
// its own config. `mae` runs `omp --profile maestro`, so it is fully isolated;
// this copy is the opt-in bridge.
//
// SECURITY: copies only the allowlisted declarative config below, and only when
// present in the default base. It NEVER copies the auth/login STORE or any state:
// `agent.db*` (the auth-broker credential vault), `history.db*`, `models.db*`,
// `sessions/`, `terminal-sessions/`, `collab/`, `cache/`, `logs/`, `memories/`,
// `autoqa.db*`, `install-id`, etc. The profile is still logged in separately via
// `omp --profile maestro` (the launcher prints this note).
//
// NOTE: the copied config is the user's OWN config moved default -> profile on
// the same machine. Files like `mcp.json` / `settings.json` MAY contain secrets
// the user themselves configured (e.g. MCP server API keys); those are copied
// as-is (byte copy, contents never parsed). The launcher prompt says so - this
// is config relocation, not credential extraction.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homeDir, type MaeEnv } from './paths';

// Allowlist: declarative config only. `SYSTEM.md` is intentionally excluded - it
// would conflict with mae's branded `--append-system-prompt`.
const CONFIG_FILES = ['config.yml', 'settings.json', 'mcp.json', 'lsp.json'] as const;
const CONFIG_DIRS = [
	'skills',
	'rules',
	'prompts',
	'instructions',
	'commands',
	'hooks',
	'tools',
	'extensions',
] as const;

export function ompDefaultBase(env: MaeEnv): string {
	return path.join(homeDir(env), '.omp', 'agent');
}

export function ompProfileBase(env: MaeEnv, profile: string): string {
	return path.join(homeDir(env), '.omp', 'profiles', profile, 'agent');
}

function isFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

function isDir(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

// Allowlisted items that actually exist in the base, in display order.
// Files render as `name`, directories as `name/`.
function presentItems(base: string): string[] {
	const items: string[] = [];
	for (const file of CONFIG_FILES) {
		if (isFile(path.join(base, file))) items.push(file);
	}
	for (const dir of CONFIG_DIRS) {
		if (isDir(path.join(base, dir))) items.push(`${dir}/`);
	}
	return items;
}

export interface OmpSettingsDetection {
	defaultBase: string;
	profileBase: string;
	/** The default omp base has settings worth copying. */
	hasExistingSetup: boolean;
	/** The Maestro profile already has settings (don't auto-prompt). */
	maestroConfigured: boolean;
	/** Allowlisted config items present in the default base (for the prompt). */
	items: string[];
}

export function detectCopyableOmpSettings(env: MaeEnv, profile: string): OmpSettingsDetection {
	const defaultBase = ompDefaultBase(env);
	const profileBase = ompProfileBase(env, profile);
	const items = presentItems(defaultBase);
	return {
		defaultBase,
		profileBase,
		hasExistingSetup: items.length > 0,
		maestroConfigured: presentItems(profileBase).length > 0,
		items,
	};
}

export interface OmpCopyResult {
	copied: string[];
	backedUp: string[];
}

// Copy allowlisted config from defaultBase -> profileBase. Any existing profile
// item is BACKED UP (renamed to `<name>.pre-mae-<timestamp>`) before overwrite -
// never destroyed. Returns what was copied / backed up (display names).
export function copyOmpSettings(defaultBase: string, profileBase: string): OmpCopyResult {
	const copied: string[] = [];
	const backedUp: string[] = [];
	fs.mkdirSync(profileBase, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');

	const copyOne = (name: string, dir: boolean): void => {
		const src = path.join(defaultBase, name);
		if (dir ? !isDir(src) : !isFile(src)) return;
		const dest = path.join(profileBase, name);
		const label = dir ? `${name}/` : name;
		if (fs.existsSync(dest)) {
			fs.renameSync(dest, `${dest}.pre-mae-${stamp}`);
			backedUp.push(label);
		}
		fs.cpSync(src, dest, { recursive: true });
		copied.push(label);
	};

	for (const file of CONFIG_FILES) copyOne(file, false);
	for (const dir of CONFIG_DIRS) copyOne(dir, true);
	return { copied, backedUp };
}
