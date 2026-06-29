// `mae` launcher: a thin wrapper that runs the host `omp` binary configured as
// the Maestro TUI (Maestro profile + bridge extension + system-prompt append +
// config overlay), and performs the best-effort bridge handshake (exchange the
// discovery secret for a per-run scoped token). `mae resume [query]` resolves a
// tracked Maestro session to an omp resume key first.
//
// Portable Node TS: the only Bun process here is the external omp binary.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BRIDGE_ENV, type BridgeDiscovery, parseDiscovery } from './protocol';
import { resolveRecord } from './session-map';
import { bridgeDiscoveryPath, homeDir, type MaeEnv } from './paths';
import * as readline from 'node:readline';
import { copyOmpSettings, detectCopyableOmpSettings } from './omp-settings';

export type LauncherEnv = MaeEnv;

// Re-exported so callers and tests can resolve the discovery file path.
export { bridgeDiscoveryPath as discoveryPathFor } from './paths';

export const PROFILE = 'maestro';

function fileExists(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

function firstExisting(candidates: string[]): string | undefined {
	return candidates.find(fileExists);
}

export function resolveOmpBin(env: LauncherEnv): string {
	const override = env.MAE_OMP_BIN;
	if (override && override.trim() !== '') return override;
	const exe = process.platform === 'win32' ? 'omp.exe' : 'omp';
	const local = path.join(homeDir(env), '.bun', 'bin', exe);
	if (fileExists(local)) return local;
	return exe; // fall back to PATH resolution
}

export interface ResolvedAssets {
	extensionPath: string;
	appendSystemPrompt: string;
	configOverlayPath?: string;
}

// Locate the bundled extension + assets relative to this module, across all
// layouts: npm/dist (dist/cli/mae.js -> ../mae), electron extraResources
// (resources/mae.js -> ./mae, siblings), and dev (src/mae -> ./extension|assets).
export function resolveAssets(moduleDir: string): ResolvedAssets {
	const extensionPath =
		firstExisting([
			path.join(moduleDir, '..', 'mae', 'maestro-bridge.extension.mjs'), // npm/dist
			path.join(moduleDir, 'mae', 'maestro-bridge.extension.mjs'), // electron resources
			path.join(moduleDir, '..', 'mae', 'maestro-bridge.extension.js'),
			path.join(moduleDir, 'mae', 'maestro-bridge.extension.js'),
			path.join(moduleDir, 'extension', 'maestro-bridge.extension.ts'), // dev
		]) ?? path.join(moduleDir, '..', 'mae', 'maestro-bridge.extension.mjs');

	const promptPath = firstExisting([
		path.join(moduleDir, '..', 'mae', 'assets', 'maestro-system.md'), // npm/dist
		path.join(moduleDir, 'mae', 'assets', 'maestro-system.md'), // electron resources
		path.join(moduleDir, 'assets', 'maestro-system.md'), // dev
	]);
	const configOverlayPath = firstExisting([
		path.join(moduleDir, '..', 'mae', 'assets', 'maestro.config.yml'), // npm/dist
		path.join(moduleDir, 'mae', 'assets', 'maestro.config.yml'), // electron resources
		path.join(moduleDir, 'assets', 'maestro.config.yml'), // dev
	]);

	return {
		extensionPath,
		appendSystemPrompt: promptPath ? fs.readFileSync(promptPath, 'utf8') : '',
		configOverlayPath,
	};
}

export interface BuildArgsOptions {
	profile: string;
	extensionPath: string;
	appendSystemPrompt: string;
	configOverlayPath?: string;
	resumeOmpSessionId?: string;
	passthrough: string[];
}

export function buildOmpArgs(options: BuildArgsOptions): string[] {
	const args: string[] = ['--profile', options.profile, '-e', options.extensionPath];
	if (options.appendSystemPrompt.trim() !== '') {
		args.push('--append-system-prompt', options.appendSystemPrompt);
	}
	if (options.configOverlayPath) args.push('--config', options.configOverlayPath);
	if (options.resumeOmpSessionId) args.push('--resume', options.resumeOmpSessionId);
	args.push(...options.passthrough);
	return args;
}

export function mapPathFor(env: LauncherEnv): string {
	const override = env[BRIDGE_ENV.mapPath];
	if (override && override.trim() !== '') return override;
	return path.join(homeDir(env), '.omp', 'profiles', PROFILE, 'agent', 'mae', 'session-map.json');
}

function safeReadJson(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf8'));
	} catch {
		return undefined;
	}
}

interface IssuedToken {
	url: string;
	token: string;
}

async function issueToken(
	discovery: BridgeDiscovery,
	runId: string,
	cwd: string
): Promise<IssuedToken | undefined> {
	try {
		const response = await fetch(`${discovery.url}/v1/sessions/issue`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ secret: discovery.secret, runId, cwd }),
		});
		const json: unknown = await response.json();
		if (json && typeof json === 'object' && 'token' in json) {
			const token = json.token;
			if (typeof token === 'string') return { url: discovery.url, token };
		}
	} catch {
		// Desktop app not reachable; bridge tools degrade gracefully.
	}
	return undefined;
}

export interface ResumeSelection {
	resumeOmpSessionId?: string;
	maestroSessionId?: string;
	passthrough: string[];
	error?: string;
}

// Parse a `resume [query]` invocation against the identity map. Exported for tests.
export async function resolveResume(argv: string[], env: LauncherEnv): Promise<ResumeSelection> {
	if (argv[0] !== 'resume') return { passthrough: argv };
	const next = argv[1];
	const query = next && !next.startsWith('-') ? next : undefined;
	const passthrough = argv.slice(query ? 2 : 1);
	const record = await resolveRecord(mapPathFor(env), query);
	if (!record) {
		return {
			passthrough,
			error: `no matching Maestro session to resume${query ? ` for "${query}"` : ''}`,
		};
	}
	return {
		resumeOmpSessionId: record.ompSessionId,
		maestroSessionId: record.maestroSessionId,
		passthrough,
	};
}

export interface RunMaeOptions {
	argv: string[];
	env?: LauncherEnv;
	moduleDir?: string;
	// Injectable writers for testability; default to the process streams.
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
	// Injectable confirm prompt for testability; defaults to a readline TTY prompt
	// (returns false on a non-TTY so scripts never block).
	confirm?: (question: string) => Promise<boolean>;
}

function spawnOmp(bin: string, args: string[], env: LauncherEnv): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	const child = spawn(bin, args, { stdio: 'inherit', env });
	const forward = (signal: NodeJS.Signals): void => {
		try {
			child.kill(signal);
		} catch {
			// child already gone
		}
	};
	process.on('SIGINT', () => forward('SIGINT'));
	process.on('SIGTERM', () => forward('SIGTERM'));
	child.on('error', (error: Error) => {
		process.stderr.write(`mae: failed to launch omp (${bin}): ${error.message}\n`);
		resolve(127);
	});
	child.on('exit', (code) => resolve(code ?? 0));
	return promise;
}

function defaultConfirm(question: string): Promise<boolean> {
	if (!process.stdin.isTTY) return Promise.resolve(false);
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise<boolean>((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(/^y(es)?$/i.test(answer.trim()));
		});
	});
}

// First-run onboarding: if the user has an existing default omp setup and the
// Maestro profile is fresh, offer to copy their config in. `--copy-omp-settings`
// forces it (no prompt); `--no-copy-omp-settings` disables. Never runs on
// `--mae-dry-run` (caller gates) and never on resume unless forced.
export async function offerOmpSettingsCopy(opts: {
	env: LauncherEnv;
	profile: string;
	explicit: boolean;
	isResume: boolean;
	confirm: (question: string) => Promise<boolean>;
	writeOut: (text: string) => void;
}): Promise<void> {
	const detect = detectCopyableOmpSettings(opts.env, opts.profile);
	if (!detect.hasExistingSetup) return;
	const shouldOffer = opts.explicit || (!detect.maestroConfigured && !opts.isResume);
	if (!shouldOffer) return;
	const ok = opts.explicit
		? true
		: await opts.confirm(
				`mae: found existing omp settings (${detect.items.join(', ')}).\n` +
					`     Copy this config into the Maestro profile? It may include secrets\n` +
					`     you set (e.g. mcp.json keys); your omp login/auth is NOT copied. [y/N] `
			);
	if (!ok) return;
	const result = copyOmpSettings(detect.defaultBase, detect.profileBase);
	if (result.copied.length === 0) return;
	opts.writeOut(`mae: copied omp config into the Maestro profile: ${result.copied.join(', ')}\n`);
	if (result.backedUp.length > 0) {
		opts.writeOut(`mae: backed up existing items (.pre-mae-*): ${result.backedUp.join(', ')}\n`);
	}
	opts.writeOut(
		'mae: note - your omp login/auth was NOT copied (separate store). Run\n' +
			'     `omp --profile maestro` once to log the Maestro profile in. Copied\n' +
			'     config may include secrets you set yourself (e.g. mcp.json keys).\n'
	);
}

export async function runMae(options: RunMaeOptions): Promise<number> {
	const env = options.env ?? process.env;
	const moduleDir = options.moduleDir ?? __dirname;
	const cwd = process.cwd();
	const writeOut = options.stdout ?? ((text: string) => void process.stdout.write(text));
	const writeErr = options.stderr ?? ((text: string) => void process.stderr.write(text));

	const dryRun = options.argv.includes('--mae-dry-run');
	const explicitCopy = options.argv.includes('--copy-omp-settings');
	const noCopy = options.argv.includes('--no-copy-omp-settings');
	const maeFlags = new Set(['--mae-dry-run', '--copy-omp-settings', '--no-copy-omp-settings']);
	const argv = options.argv.filter((arg) => !maeFlags.has(arg));

	const resume = await resolveResume(argv, env);
	if (resume.error) {
		writeErr(`mae: ${resume.error}\n`);
		return 1;
	}

	const assets = resolveAssets(moduleDir);
	const ompBin = resolveOmpBin(env);
	const runId = randomUUID();

	const args = buildOmpArgs({
		profile: PROFILE,
		extensionPath: assets.extensionPath,
		appendSystemPrompt: assets.appendSystemPrompt,
		configOverlayPath: assets.configOverlayPath,
		resumeOmpSessionId: resume.resumeOmpSessionId,
		passthrough: resume.passthrough,
	});

	const childEnv: LauncherEnv = {
		...env,
		[BRIDGE_ENV.runId]: runId,
		[BRIDGE_ENV.mapPath]: mapPathFor(env),
	};
	if (resume.maestroSessionId) childEnv[BRIDGE_ENV.maestroSessionId] = resume.maestroSessionId;

	const discovery = parseDiscovery(safeReadJson(bridgeDiscoveryPath(env)));
	if (discovery) {
		const issued = await issueToken(discovery, runId, cwd);
		if (issued) {
			childEnv[BRIDGE_ENV.url] = issued.url;
			childEnv[BRIDGE_ENV.token] = issued.token;
		}
	}

	if (dryRun) {
		writeOut(
			JSON.stringify(
				{
					ompBin,
					args,
					runId,
					mapPath: childEnv[BRIDGE_ENV.mapPath],
					bridgeConnected: Boolean(childEnv[BRIDGE_ENV.token]),
					maestroSessionId: childEnv[BRIDGE_ENV.maestroSessionId],
				},
				null,
				2
			) + '\n'
		);
		return 0;
	}

	if (!noCopy) {
		await offerOmpSettingsCopy({
			env,
			profile: PROFILE,
			explicit: explicitCopy,
			isResume: Boolean(resume.resumeOmpSessionId),
			confirm: options.confirm ?? defaultConfirm,
			writeOut,
		});
	}

	return spawnOmp(ompBin, args, childEnv);
}
