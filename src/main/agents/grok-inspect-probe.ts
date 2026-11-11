/**
 * What `grok inspect --json` says a Grok launch will inherit.
 *
 * grok 1.0.70 loads configuration that is not its own: Claude's and Cursor's
 * skills, rules, instruction files, MCP servers and hooks (the `externalCompat`
 * cells), and Claude's permission files (`~/.claude/settings.json`,
 * `settings.local.json` and the project's), whatever GROK_HOME says. Maestro
 * switches the compat cells off for every launch it owns
 * (`GROK_COMPAT_ISOLATION_ENV_VARS` in the provider definitions); the
 * permission files have no native off switch in 1.0.70, so an isolated launch
 * still reports them under `permissions.sources`.
 *
 * `inspect` is a local command: no credentials, no model call, exit 0 with an
 * empty GROK_HOME. This module reads its report, names what is inherited, and
 * decides whether the read-only composition (`--permission-mode plan --deny
 * Bash(*)`) can stand on it: it cannot while foreign permission files load,
 * since their allow rules join the rule set the plan-mode turn is held to.
 *
 * The probe runs through `runProviderProbe` (`grok-probe.ts`), the one lifetime
 * path for provider probes. It refuses every Grok exec probe until the host
 * proves finite probe lifetime, so on today's hosts the probe answers
 * `unavailable` with the refusal's message and nothing is started. The runner
 * is injectable so a test (or a later host that lifts the refusal) drives the
 * same parser and decision.
 */

import type { ExecResult } from '../utils/execFile';
import {
	ProviderProbeRefusedError,
	runProviderProbe,
	type ProviderProbeRequest,
} from './grok-probe';

/** One vendor-compatibility cell as `grok inspect --json` reports it. */
export interface GrokCompatCell {
	vendor: string;
	surface: string;
	enabled: boolean;
	/** Where the value came from: `default`, `env` or `config`. */
	source: string;
}

/** A discovered hook, reduced to what decides whether it runs. */
export interface GrokInspectHook {
	event: string;
	/** `claude`, `cursor`, or absent for grok's own hooks. */
	vendor?: string;
	disabled: boolean;
}

/** The facts of one `grok inspect --json` report Maestro acts on. */
export interface GrokInspectReport {
	grokVersion?: string;
	projectRoot: string | null;
	/** null when the report did not say. */
	projectTrusted: boolean | null;
	/** `permissions.sources`, verbatim (`<path> (settings)`, `<path> (config)`). */
	permissionSources: string[];
	/** `permissions.loaded`: how many rules the sources contributed. */
	permissionRulesLoaded: number | null;
	hooks: GrokInspectHook[];
	/** Names of discovered MCP servers. */
	mcpServers: string[];
	compatCells: GrokCompatCell[];
}

/** The probe's answer for one account and cwd. */
export type GrokInspectProbeResult =
	| {
			status: 'observed';
			report: GrokInspectReport;
			/** Claude-format permission files the launch still loads. */
			inheritedPermissionSources: string[];
			/** Compat cells still on, as `<vendor>.<surface>`. */
			enabledCompatCells: string[];
			/** Hooks from another vendor that will run. */
			activeForeignHooks: GrokInspectHook[];
			/** The read-only refusal, or null when read-only can stand on this launch. */
			readOnlyProblem: string | null;
	  }
	| {
			status: 'unavailable';
			reason: 'probe-refused' | 'probe-failed' | 'invalid-report';
			message: string;
	  };

const SETTINGS_SOURCE_SUFFIX = ' (settings)';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Parse `grok inspect --json` stdout. Null when it is not a JSON object or
 * carries none of the fields the decision needs (a different command, a
 * version that renamed them): an unreadable report never reads as isolated.
 */
export function parseGrokInspectReport(stdout: string): GrokInspectReport | null {
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!isRecord(raw)) return null;
	const permissions = raw.permissions;
	const compat = raw.externalCompat;
	if (!isRecord(permissions) || !Array.isArray(permissions.sources)) return null;
	if (!isRecord(compat) || !Array.isArray(compat.cells)) return null;

	const compatCells: GrokCompatCell[] = [];
	for (const cell of compat.cells) {
		if (
			isRecord(cell) &&
			typeof cell.vendor === 'string' &&
			typeof cell.surface === 'string' &&
			typeof cell.enabled === 'boolean'
		) {
			compatCells.push({
				vendor: cell.vendor,
				surface: cell.surface,
				enabled: cell.enabled,
				source: typeof cell.source === 'string' ? cell.source : 'unknown',
			});
		}
	}
	const hooks: GrokInspectHook[] = [];
	if (Array.isArray(raw.hooks)) {
		for (const hook of raw.hooks) {
			if (!isRecord(hook) || typeof hook.event !== 'string') continue;
			hooks.push({
				event: hook.event,
				...(typeof hook.vendor === 'string' ? { vendor: hook.vendor } : {}),
				disabled: hook.disabled === true,
			});
		}
	}
	const mcpServers: string[] = [];
	if (Array.isArray(raw.mcpServers)) {
		for (const server of raw.mcpServers) {
			if (typeof server === 'string') mcpServers.push(server);
			else if (isRecord(server) && typeof server.name === 'string') mcpServers.push(server.name);
		}
	}
	return {
		...(typeof raw.grokVersion === 'string' ? { grokVersion: raw.grokVersion } : {}),
		projectRoot: typeof raw.projectRoot === 'string' ? raw.projectRoot : null,
		projectTrusted: typeof raw.projectTrusted === 'boolean' ? raw.projectTrusted : null,
		permissionSources: stringList(permissions.sources),
		permissionRulesLoaded: typeof permissions.loaded === 'number' ? permissions.loaded : null,
		hooks,
		mcpServers,
		compatCells,
	};
}

/**
 * The Claude-format permission files a launch loads, as paths. grok labels
 * them `<path> (settings)`; its own TOML layers are `(config)` and Maestro
 * leaves them alone.
 */
export function inheritedGrokPermissionSources(report: GrokInspectReport): string[] {
	return report.permissionSources
		.filter((source) => source.endsWith(SETTINGS_SOURCE_SUFFIX))
		.map((source) => source.slice(0, -SETTINGS_SOURCE_SUFFIX.length));
}

/** Compat cells still switched on, as `<vendor>.<surface>`. */
export function enabledGrokCompatCells(report: GrokInspectReport): string[] {
	return report.compatCells.filter((c) => c.enabled).map((c) => `${c.vendor}.${c.surface}`);
}

/**
 * Why the read-only composition cannot stand on this launch, naming each
 * inherited permission file, or null when none loads. Read-only is plan mode
 * plus a Bash deny; an allow rule from a foreign file joins that rule set and
 * Maestro cannot see or remove it, so the composition is refused rather than
 * labelled read-only.
 */
export function grokReadOnlyIsolationProblem(report: GrokInspectReport): string | null {
	const inherited = inheritedGrokPermissionSources(report);
	if (inherited.length === 0) return null;
	return (
		`Grok read-only refused: inherited permission rules still load from ${inherited.join(', ')}. ` +
		'grok 1.0.70 has no setting that stops it reading Claude permission files.'
	);
}

export interface GrokInspectProbeInput {
	/** Absolute path of the grok executable the launch will run. */
	command: string;
	/** The launch's working directory. */
	cwd: string;
	/** The launch's full environment (GROK_HOME of the selected account, isolation vars). */
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}

export type GrokInspectRunner = (request: ProviderProbeRequest) => Promise<ExecResult>;

/** Bounds for one inspect run: a local command that answers in about a second. */
export const GROK_INSPECT_PROBE_LIMITS = Object.freeze({
	timeoutMs: 30_000,
	maxOutputBytes: 4 * 1024 * 1024,
});

/**
 * Run `grok inspect --json` for the selected account and cwd and decide what
 * the launch inherits. A refused or failed probe is `unavailable`, never an
 * empty (isolated-looking) report.
 */
export async function probeGrokInspect(
	input: GrokInspectProbeInput,
	run: GrokInspectRunner = runProviderProbe
): Promise<GrokInspectProbeResult> {
	let result: ExecResult;
	try {
		result = await run({
			providerId: 'grok',
			kind: 'inspect',
			command: input.command,
			args: ['inspect', '--json'],
			cwd: input.cwd,
			env: input.env,
			limits: { ...GROK_INSPECT_PROBE_LIMITS },
			...(input.signal ? { signal: input.signal } : {}),
		});
	} catch (error) {
		if (error instanceof ProviderProbeRefusedError) {
			return { status: 'unavailable', reason: 'probe-refused', message: error.message };
		}
		throw error;
	}
	if (result.exitCode !== 0) {
		return {
			status: 'unavailable',
			reason: 'probe-failed',
			message: `grok inspect --json exited ${String(result.exitCode)}.`,
		};
	}
	const report = parseGrokInspectReport(result.stdout);
	if (!report) {
		return {
			status: 'unavailable',
			reason: 'invalid-report',
			message: 'grok inspect --json printed no readable report.',
		};
	}
	return {
		status: 'observed',
		report,
		inheritedPermissionSources: inheritedGrokPermissionSources(report),
		enabledCompatCells: enabledGrokCompatCells(report),
		activeForeignHooks: report.hooks.filter((h) => h.vendor !== undefined && !h.disabled),
		readOnlyProblem: grokReadOnlyIsolationProblem(report),
	};
}
