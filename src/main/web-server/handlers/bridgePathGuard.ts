/**
 * Argument-level guards for `bridge.invoke` from web (non-CLI) clients.
 *
 * The bridge dispatches ANY registered ipcMain handler for an authenticated
 * browser, including the generic filesystem verbs (`fs:readFile`,
 * `fs:readDir`, `fs:writeFile`, `fs:delete`, ...). Denying the
 * `computerHistory:` namespace (bridgeDenyList.ts) therefore did not, by
 * itself, keep a browser out of the store: it could read, rewrite, or delete
 * `<userData>/computer-history/` through `fs:*`, or read `cli-server.json`
 * for this boot's CLI secret and reconnect as `maestro-cli`.
 *
 * Two guards close that, for web clients only (`client.cli` is exempt: the
 * CLI runs as the local user and already has the files):
 *
 * 1. Protected paths. Every string argument, at any depth in arrays and plain
 *    objects, is resolved like a path (`~` and `file://` expanded,
 *    `path.resolve`, symlinks resolved through the nearest existing ancestor,
 *    case-insensitive on macOS and Windows) and refused when it is inside
 *    `<userData>/computer-history` or is the CLI discovery file. Channels that
 *    destroy or move things also refuse an ANCESTOR of those paths, so
 *    `fs:delete <userData>` cannot take the store with it.
 * 2. The Computer History flag. `settings:set` writes that would change
 *    `encoreFeatures.computerHistory`, and the marketplace toggle for that
 *    flag, are refused; a browser may not turn recording on or off. The WS
 *    `set_setting` message applies the same check (see settings.ts).
 *
 * What this does NOT do: the bridge still exposes every other handler to a
 * signed-in browser, which is broad access to the machine by design
 * (web-desktop is the whole app). Only Computer History data and the CLI
 * secret are walled off here.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { resolveEncoreFeatures } from '../../../shared/encoreFeatureDefaults';
import { COMPUTER_HISTORY_DIR_NAME } from '../../../shared/computer-history/paths';
import { cliServerInfoPath } from '../../../shared/cli-server-discovery';

export interface BridgeGuardContext {
	/** Electron userData, or null when it cannot be resolved (tests, headless). */
	userDataDir: string | null;
	/** Current `encoreFeatures` value from the settings store. */
	encoreFeatures: unknown;
	platform: NodeJS.Platform;
}

function defaultContext(): BridgeGuardContext {
	let userDataDir: string | null = null;
	let encoreFeatures: unknown = undefined;
	try {
		// Lazy so this module loads in tests that mock electron without `app`.
		const { app } = require('electron') as typeof import('electron');
		userDataDir = app?.getPath?.('userData') ?? null;
	} catch {
		userDataDir = null;
	}
	try {
		const { getSettingsStore } =
			require('../../stores/getters') as typeof import('../../stores/getters');
		encoreFeatures = getSettingsStore().get('encoreFeatures');
	} catch {
		encoreFeatures = undefined;
	}
	return { userDataDir, encoreFeatures, platform: process.platform };
}

let contextProvider: () => BridgeGuardContext = defaultContext;

/** Test seam. Pass null to restore the Electron-backed default. */
export function setBridgeGuardContextProvider(provider: (() => BridgeGuardContext) | null): void {
	contextProvider = provider ?? defaultContext;
}

/** Channels where an ancestor of a protected path is as dangerous as the path. */
const DESTRUCTIVE_CHANNEL_RE = /(delete|remove|rename|move|trash|unlink|rmdir|wipe|clear)/i;

const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_STRINGS = 2000;

function caseFold(p: string, platform: NodeJS.Platform): string {
	return platform === 'darwin' || platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Resolve symlinks through the nearest existing ancestor, so a not-yet-created
 * file under a symlinked directory still resolves to where it would land.
 */
function realpathLoose(p: string): string {
	let current = p;
	const rest: string[] = [];
	for (let i = 0; i < 64; i++) {
		try {
			const real = fs.realpathSync.native(current);
			return rest.length > 0 ? path.join(real, ...rest.reverse()) : real;
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return p;
			rest.push(path.basename(current));
			current = parent;
		}
	}
	return p;
}

/** Turn an argument string into an absolute path the way a handler would. */
function toPath(value: string): string | null {
	let v = value.trim();
	if (!v || v.length > 4096 || v.includes('\0')) return null;
	if (v.startsWith('file://')) {
		try {
			v = fileURLToPath(v);
		} catch {
			return null;
		}
	}
	if (v === '~' || v.startsWith('~/') || v.startsWith('~\\'))
		v = path.join(os.homedir(), v.slice(1));
	return path.resolve(v);
}

function isInside(child: string, parent: string): boolean {
	if (child === parent) return true;
	const rel = path.relative(parent, child);
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Every string at any depth in `args` (bounded). */
function collectStrings(value: unknown, out: string[], depth: number): void {
	if (out.length >= MAX_SCAN_STRINGS || depth > MAX_SCAN_DEPTH) return;
	if (typeof value === 'string') {
		out.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, out, depth + 1);
		return;
	}
	if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			collectStrings(k, out, depth + 1);
			collectStrings(v, out, depth + 1);
		}
	}
}

export interface ProtectedPathHit {
	argument: string;
	protectedPath: string;
}

/**
 * The first argument that touches a protected path, or null. Pure apart from
 * `realpath` lookups; exported for tests.
 */
export function findProtectedPathArg(
	channel: string,
	args: readonly unknown[],
	ctx: BridgeGuardContext
): ProtectedPathHit | null {
	const roots: string[] = [];
	const files: string[] = [cliServerInfoPath()];
	if (ctx.userDataDir) {
		roots.push(path.join(ctx.userDataDir, COMPUTER_HISTORY_DIR_NAME));
		files.push(path.join(ctx.userDataDir, 'cli-server.json'));
	}
	for (const f of [...files]) files.push(`${f}.tmp`);
	const fold = (p: string) => caseFold(realpathLoose(path.resolve(p)), ctx.platform);
	const protectedRoots = roots.map((r) => ({ raw: r, folded: fold(r) }));
	const protectedFiles = files.map((f) => ({ raw: f, folded: fold(f) }));
	const destructive = DESTRUCTIVE_CHANNEL_RE.test(channel);

	const strings: string[] = [];
	collectStrings(args, strings, 0);
	for (const s of strings) {
		const resolved = toPath(s);
		if (!resolved) continue;
		const candidate = caseFold(realpathLoose(resolved), ctx.platform);
		for (const root of protectedRoots) {
			if (isInside(candidate, root.folded)) return { argument: s, protectedPath: root.raw };
			if (destructive && isInside(root.folded, candidate)) {
				return { argument: s, protectedPath: root.raw };
			}
		}
		for (const file of protectedFiles) {
			if (candidate === file.folded) return { argument: s, protectedPath: file.raw };
			if (destructive && isInside(file.folded, candidate)) {
				return { argument: s, protectedPath: file.raw };
			}
		}
	}
	return null;
}

/** The current resolved Computer History flag. */
export function currentComputerHistoryFlag(ctx: BridgeGuardContext = contextProvider()): boolean {
	return resolveEncoreFeatures(ctx.encoreFeatures).computerHistory === true;
}

/**
 * Whether a settings write would change the Computer History flag. Handles the
 * whole-object key (`encoreFeatures`) and electron-store dot keys
 * (`encoreFeatures.computerHistory`).
 */
export function settingsWriteChangesComputerHistory(
	key: unknown,
	value: unknown,
	current: boolean
): boolean {
	if (key === 'encoreFeatures') {
		return resolveEncoreFeatures(value).computerHistory !== current;
	}
	if (key === 'encoreFeatures.computerHistory') {
		return (value === true) !== current;
	}
	return false;
}

/**
 * Why a web client's bridge call must be refused, or null when it may run.
 * Callers skip this for CLI clients.
 */
export function bridgeGuardViolation(channel: string, args: readonly unknown[]): string | null {
	const ctx = contextProvider();
	if (
		channel === 'settings:set' &&
		settingsWriteChangesComputerHistory(args[0], args[1], currentComputerHistoryFlag(ctx))
	) {
		return 'Computer History can only be turned on or off from the Maestro desktop app';
	}
	if (channel === 'plugins:first-party-set-enabled' && args[0] === 'computerHistory') {
		return 'Computer History can only be turned on or off from the Maestro desktop app';
	}
	const hit = findProtectedPathArg(channel, args, ctx);
	if (hit)
		return `"${channel}" may not touch ${path.basename(hit.protectedPath)} over the web interface`;
	return null;
}
