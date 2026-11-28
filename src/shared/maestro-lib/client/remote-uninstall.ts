/**
 * Undoing what Maestro set up on an SSH remote: `remote-host stop` and `remote-host uninstall`,
 * and the desktop's Stop Host and Remove Host, which call the same `stopRemoteHost()`.
 *
 * Two ssh calls, one after the other (never side by side: tailcat remotes fail under concurrent
 * dials):
 *
 * 1. The survey (`buildRemoteHostSurveyScript()`), read-only: which `maestro-cli` is there and who
 *    installed it, whether a host runs and whether it is the desktop app, the boot service, the
 *    data directory, and the agents the host holds.
 * 2. The act (`buildRemoteHostStopScript()`), only once the survey allows it: disable the boot
 *    service, stop the host (`host stop --wait`, which drains work in flight), and for an
 *    uninstall remove the service file and Maestro's own files under `~/.maestro`.
 *
 * What is never touched:
 * - A `maestro-cli` Maestro did not install (Maestro.app, the server bundle): it is named, not removed.
 * - `~/.maestro/host.env`, the person's own settings for the host.
 * - The host's data directory, unless the caller asks (`purgeData`), and never while the host
 *   holds an agent or while the desktop app uses that directory too.
 * - A remote where the Maestro desktop app is the host: it is reported, and nothing changes.
 *
 * Only the remote's own tools run there (`systemctl --user`, `launchctl`, `rm`), as the SSH user.
 * Nothing asks for sudo. The endpoint's token never leaves the remote shell: the survey greps it.
 */

import { redactSecrets } from '../../redactSecrets';
import { describeSshConnectionError } from '../../sshConnection';
import type { SshRemoteConfig } from '../../types';
import { execFileNoThrow } from '../launch/exec-file';
import { resolveSshPath } from '../launch/ssh-path';
import { MAC_APP_CLI_PATH, buildRemoteScriptArgs, type RemoteExec } from './remote-discovery';
import { REMOTE_INSTALL_ROOT } from './remote-install';
import { REMOTE_SERVICE_LABEL, REMOTE_SERVICE_UNIT } from './remote-service';

const MARKER = 'MAESTRO_HOST=';
const AGENTS_BEGIN = `${MARKER}agents-begin`;
const AGENTS_END = `${MARKER}agents-end`;

/** How long `host stop --wait` lets work in flight finish, in seconds. */
export const REMOTE_HOST_STOP_WAIT_SECONDS = 120;

/**
 * The lines both scripts start with: they find the CLI, the host, the boot service and the data
 * directory, and print each fact as a `MAESTRO_HOST=` marker. Nothing here changes the remote.
 */
function surveyPreamble(): string[] {
	const app = `'${MAC_APP_CLI_PATH}'`;
	return [
		`M='${MARKER}'`,
		`say() { printf '%s%s\\n' "$M" "$1"; }`,
		`root="$HOME/${REMOTE_INSTALL_ROOT}"; bin="$root/bin"; ours="$bin/maestro-cli"`,
		// The same settings the service wrapper reads, so the CLI resolves the same data directory.
		'[ -f "$root/host.env" ] && . "$root/host.env"',
		'case "$(uname -s)" in Linux*) os=linux;; Darwin*) os=darwin;; MINGW*|MSYS*|CYGWIN*) os=win;; *) os=other;; esac',
		'say "os=$os"',
		// Every maestro-cli Maestro did not install: on PATH, and the Mac app's bundle.
		'foreign=""',
		'set -f; _ifs=$IFS; IFS=:',
		'for d in $PATH; do if [ -n "$d" ] && [ -x "$d/maestro-cli" ] && [ "$d/maestro-cli" != "$ours" ]; then say "foreign=$d/maestro-cli"; [ -n "$foreign" ] || foreign="$d/maestro-cli"; fi; done',
		'IFS=$_ifs; set +f',
		`[ "$os" = darwin ] && [ -f ${app} ] && say "foreign=${MAC_APP_CLI_PATH}"`,
		'[ -x "$ours" ] && say installed=1',
		'{ [ -d "$root/cli" ] || [ -d "$root/node" ] || [ -e "$bin/maestro-host-service" ]; } && say files=1',
		// The CLI that answers for the host: Maestro's own first, then any other.
		'have=1',
		'if [ -x "$ours" ]; then _mc() { "$ours" "$@"; }',
		'elif [ -n "$foreign" ]; then _mc() { "$foreign" "$@"; }',
		`elif [ "$os" = darwin ] && [ -f ${app} ] && command -v node >/dev/null 2>&1; then _mc() { node ${app} "$@"; }`,
		'else have=0; fi',
		// Is a host serving the data directory, and is it the desktop app? The endpoint holds the
		// token, so it is grepped here and never printed.
		'running=0; headless=0; pid=""',
		'if [ "$have" = 1 ]; then',
		'  ep=$(_mc host endpoint --json 2>/dev/null)',
		`  printf '%s\\n' "$ep" | grep -q '"running": *true' && running=1`,
		`  pid=$(printf '%s\\n' "$ep" | sed -n 's/^ *"pid": *\\([0-9][0-9]*\\).*/\\1/p' | head -n 1)`,
		'  ep=""',
		`  [ "$running" = 1 ] && _mc version --json 2>/dev/null | grep -q '"hostKind": *"headless"' && headless=1`,
		'fi',
		'if [ "$running" = 0 ]; then say host=none; elif [ "$headless" = 1 ]; then say host=headless; else say host=desktop; fi',
		'[ -n "$pid" ] && say "pid=$pid"',
		// The boot service.
		'service=none',
		'if [ "$os" = linux ]; then',
		'  [ -n "${XDG_RUNTIME_DIR:-}" ] || { [ -d "/run/user/$(id -u)" ] && export XDG_RUNTIME_DIR="/run/user/$(id -u)"; }',
		`  unit="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${REMOTE_SERVICE_UNIT}.service"`,
		'  if [ -f "$unit" ]; then',
		'    service=systemd; say "service-file=$unit"',
		`    if systemctl --user is-enabled --quiet ${REMOTE_SERVICE_UNIT} 2>/dev/null; then say service-enabled=1; else say service-enabled=0; fi`,
		`    if systemctl --user is-active --quiet ${REMOTE_SERVICE_UNIT} 2>/dev/null; then say service-active=1; else say service-active=0; fi`,
		'  fi',
		'elif [ "$os" = darwin ]; then',
		`  plist="$HOME/Library/LaunchAgents/${REMOTE_SERVICE_LABEL}.plist"`,
		'  uid=$(id -u); domain="gui/$uid"; launchctl print "$domain" >/dev/null 2>&1 || domain="user/$uid"',
		'  if [ -f "$plist" ]; then',
		'    service=launchd; say "service-file=$plist"',
		`    if launchctl print-disabled "$domain" 2>/dev/null | grep -Eq '"${REMOTE_SERVICE_LABEL.replace(/\./g, '\\.')}" => (true|disabled)'; then say service-enabled=0; else say service-enabled=1; fi`,
		`    if launchctl print "$domain/${REMOTE_SERVICE_LABEL}" >/dev/null 2>&1; then say service-active=1; else say service-active=0; fi`,
		'  fi',
		'fi',
		'say "service=$service"',
		// The data directory, resolved the way the CLI does (`resolveUserDataDir()`).
		'if [ -n "${MAESTRO_USER_DATA:-}" ]; then data="$MAESTRO_USER_DATA"; else',
		'  case "$os" in',
		'    darwin) base="$HOME/Library/Application Support"; guess=Maestro; alt=maestro;;',
		'    win) base="${APPDATA:-$HOME/AppData/Roaming}"; guess=Maestro; alt=maestro;;',
		'    *) base="${XDG_CONFIG_HOME:-$HOME/.config}"; guess=maestro; alt=Maestro;;',
		'  esac',
		'  data="$base/$guess"',
		'  [ ! -d "$data" ] && [ -d "$base/$alt" ] && data="$base/$alt"',
		'fi',
		'if [ -d "$data" ]; then say "data=$data"; [ -f "$data/maestro-window-state.json" ] && say data-desktop=1; fi',
	];
}

/**
 * The read-only survey. With `agents`, it also prints the host's agents (`list agents --json`,
 * which reads the data directory, so it answers with the host stopped too) between two markers,
 * or `agents=unknown` when they could not be read. Always exits 0.
 */
export function buildRemoteHostSurveyScript(options: { agents?: boolean } = {}): string {
	const lines = surveyPreamble();
	if (options.agents) {
		lines.push(
			'if [ "$have" = 0 ] || [ ! -d "$data" ]; then say agents-begin; echo "[]"; say agents-end;',
			'elif _list=$(_mc list agents --json 2>/dev/null); then say agents-begin; printf \'%s\\n\' "$_list"; say agents-end;',
			'else say agents=unknown; fi'
		);
	}
	lines.push('exit 0');
	return lines.join('\n');
}

export interface RemoteHostStopScriptOptions {
	/** Also remove the service file and Maestro's own files under `~/.maestro`. */
	uninstall?: boolean;
	/** Uninstall only: also remove the host's data directory. */
	purgeData?: boolean;
}

/**
 * The script that stops the host and disables its boot service, and with `uninstall` removes what
 * Maestro installed. Prints `did=`, `removed=`, `kept=`, `warn=` and `error=` markers after the
 * survey's. It changes nothing on a remote where the desktop app is the host (`refused=desktop`).
 */
export function buildRemoteHostStopScript(options: RemoteHostStopScriptOptions = {}): string {
	const uninstall = options.uninstall === true;
	const purge = uninstall && options.purgeData === true;
	const label = REMOTE_SERVICE_LABEL;
	const lines = [
		...surveyPreamble(),
		`UNINSTALL=${uninstall ? 1 : 0}`,
		`PURGE=${purge ? 1 : 0}`,
		'[ "$running" = 1 ] && [ "$headless" = 0 ] && { say refused=desktop; exit 0; }',
		// 1. The service first, so nothing starts the host again behind the stop.
		'if [ "$service" = systemd ]; then',
		`  if systemctl --user disable ${REMOTE_SERVICE_UNIT} >/dev/null 2>&1; then say did=service-disabled; else say warn=service-disable-failed; fi`,
		'elif [ "$service" = launchd ]; then',
		`  if launchctl disable "$domain/${label}" >/dev/null 2>&1; then say did=service-disabled; else say warn=service-disable-failed; fi`,
		'fi',
		// 2. The host, drained: `host stop --wait` lets work in flight finish first.
		'if [ "$running" = 1 ]; then',
		`  _out=$(_mc host stop --wait ${REMOTE_HOST_STOP_WAIT_SECONDS} 2>&1); _rc=$?`,
		`  if [ "$_rc" != 0 ]; then printf '%s\\n' "$_out" | tail -n 3 >&2; say error=host-stop; exit 0; fi`,
		'  say did=host-stopped',
		'fi',
		// 3. The service manager's own copy, which a service-run host may still be under.
		`[ "$service" = systemd ] && systemctl --user stop ${REMOTE_SERVICE_UNIT} >/dev/null 2>&1`,
		`[ "$service" = launchd ] && launchctl bootout "$domain/${label}" >/dev/null 2>&1`,
		'if [ "$have" = 1 ]; then',
		`  _mc host endpoint --json 2>/dev/null | grep -q '"running": *true' && { say error=still-running; exit 0; }`,
		'fi',
		'if [ "$UNINSTALL" = 1 ]; then',
		'  if [ "$service" = systemd ]; then rm -f "$unit" && say "removed=$unit"; systemctl --user daemon-reload >/dev/null 2>&1; fi',
		// A disabled label stays disabled after its plist is gone, and would block a later install.
		`  if [ "$service" = launchd ]; then rm -f "$plist" && say "removed=$plist"; launchctl enable "$domain/${label}" >/dev/null 2>&1; fi`,
		'  for p in "$root/cli" "$root/cli.old" "$root/node" "$root/npm-cache" "$ours" "$bin/maestro-cli.new" "$bin/maestro-host-service" "$bin/maestro-host-service.new" "$root"/cli.stage.* "$root"/node.dl.*; do',
		'    { [ -e "$p" ] || [ -L "$p" ]; } || continue',
		'    if rm -rf "$p"; then say "removed=$p"; else say "error=remove"; exit 0; fi',
		'  done',
		'  rmdir "$bin" 2>/dev/null',
		'  [ -f "$root/host.env" ] && say "kept=$root/host.env"',
		'  rmdir "$root" 2>/dev/null && say "removed=$root"',
		'fi',
		'if [ "$PURGE" = 1 ]; then',
		// The laptop checked these before it asked; checked again where the files are.
		'  if [ -z "$data" ] || [ "$data" = "$HOME" ] || [ "$data" = / ]; then say refused=purge-path',
		'  elif [ -f "$data/maestro-window-state.json" ]; then say refused=purge-desktop',
		'  elif [ -d "$data" ]; then if rm -rf "$data"; then say "removed=$data"; else say error=purge; exit 0; fi',
		'  fi',
		'fi',
		'say done',
		'exit 0',
	];
	return lines.join('\n');
}

/** Who answers for the host on the remote. */
export type RemoteHostKind = 'none' | 'headless' | 'desktop';

/** The remote's boot service, as the survey found it. */
export type RemoteServiceStatus =
	| { kind: 'none' }
	| {
			kind: 'systemd' | 'launchd';
			/** The service file Maestro wrote. */
			file: string;
			/** It starts the host at boot (systemd) or login (launchd). */
			enabled: boolean;
			/** The service manager runs it now (systemd active, launchd loaded). */
			active: boolean;
	  };

/** One agent the host holds. */
export interface RemoteHostAgent {
	id: string;
	name: string;
}

/** What the survey found. */
export interface RemoteHostSurvey {
	os: 'linux' | 'darwin' | 'win' | 'other';
	/** Maestro's own launcher is in `~/.maestro/bin`. */
	installed: boolean;
	/** Some of Maestro's files are under `~/.maestro` (an install, or what is left of one). */
	hasFiles: boolean;
	/** Each `maestro-cli` Maestro did not install. Never removed. */
	foreign: string[];
	host: RemoteHostKind;
	pid?: number;
	service: RemoteServiceStatus;
	/** The host's data directory, when it exists. */
	dataDir?: string;
	/** The desktop app uses that data directory too. */
	dataDirUsedByDesktop: boolean;
	/** The agents in the host's data directory; `unknown` when they could not be read; absent when not asked. */
	agents?: RemoteHostAgent[] | 'unknown';
}

interface ParsedOutput {
	markers: Map<string, string[]>;
	agentsJson?: string;
}

function readMarkers(stdout: string): ParsedOutput {
	const markers = new Map<string, string[]>();
	const agentLines: string[] = [];
	let inAgents = false;
	let sawAgents = false;
	for (const raw of stdout.split(/\r?\n/)) {
		const line = raw.trimEnd();
		if (line === AGENTS_BEGIN) {
			inAgents = true;
			sawAgents = true;
			continue;
		}
		if (line === AGENTS_END) {
			inAgents = false;
			continue;
		}
		if (inAgents) {
			agentLines.push(raw);
			continue;
		}
		if (!line.startsWith(MARKER)) continue;
		const body = line.slice(MARKER.length);
		const at = body.indexOf('=');
		const key = at === -1 ? body : body.slice(0, at);
		const value = at === -1 ? '' : body.slice(at + 1);
		markers.set(key, [...(markers.get(key) ?? []), value]);
	}
	return { markers, ...(sawAgents ? { agentsJson: agentLines.join('\n') } : {}) };
}

/** `list agents --json` rows (an array, or one object per line), reduced to id and name. */
export function parseRemoteAgentList(raw: string): RemoteHostAgent[] | null {
	const toAgent = (row: unknown): RemoteHostAgent | null => {
		if (!row || typeof row !== 'object') return null;
		const { id, name } = row as Record<string, unknown>;
		if (typeof id !== 'string' || !id) return null;
		return { id, name: typeof name === 'string' && name ? name : id };
	};
	const text = raw.trim();
	if (!text) return [];
	try {
		const parsed: unknown = JSON.parse(text);
		const rows = Array.isArray(parsed) ? parsed : [parsed];
		const agents = rows.map(toAgent);
		return agents.every(Boolean) ? (agents as RemoteHostAgent[]) : null;
	} catch {
		const agents: RemoteHostAgent[] = [];
		for (const line of text.split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				const agent = toAgent(JSON.parse(line));
				if (!agent) return null;
				agents.push(agent);
			} catch {
				return null;
			}
		}
		return agents;
	}
}

function first(markers: Map<string, string[]>, key: string): string | undefined {
	return markers.get(key)?.[0];
}

function surveyFrom(parsed: ParsedOutput): RemoteHostSurvey | null {
	const { markers } = parsed;
	const os = first(markers, 'os');
	const serviceKind = first(markers, 'service');
	if (!os || !serviceKind) return null;
	const hostRaw = first(markers, 'host');
	const host: RemoteHostKind = hostRaw === 'headless' || hostRaw === 'desktop' ? hostRaw : 'none';
	const pid = Number(first(markers, 'pid'));
	const file = first(markers, 'service-file');
	const service: RemoteServiceStatus =
		(serviceKind === 'systemd' || serviceKind === 'launchd') && file
			? {
					kind: serviceKind,
					file,
					enabled: first(markers, 'service-enabled') === '1',
					active: first(markers, 'service-active') === '1',
				}
			: { kind: 'none' };
	let agents: RemoteHostSurvey['agents'];
	if (parsed.agentsJson !== undefined)
		agents = parseRemoteAgentList(parsed.agentsJson) ?? 'unknown';
	else if (first(markers, 'agents') === 'unknown') agents = 'unknown';
	const dataDir = first(markers, 'data');
	return {
		os: os === 'linux' || os === 'darwin' || os === 'win' ? os : 'other',
		installed: first(markers, 'installed') === '1',
		hasFiles: first(markers, 'files') === '1' || first(markers, 'installed') === '1',
		foreign: [...new Set(markers.get('foreign') ?? [])],
		host,
		...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
		service,
		...(dataDir ? { dataDir } : {}),
		dataDirUsedByDesktop: first(markers, 'data-desktop') === '1',
		...(agents !== undefined ? { agents } : {}),
	};
}

/** Parse the survey script's output, or null when the remote did not run it. */
export function parseRemoteHostSurvey(stdout: string): RemoteHostSurvey | null {
	return surveyFrom(readMarkers(stdout));
}

/** Why a stop or an uninstall could not finish. The message holds no secret. */
export type RemoteHostStopErrorCode =
	| 'ssh-failed'
	| 'timeout'
	/** The host did not stop (work still in flight after the wait, or it refused). */
	| 'host-stop'
	/** The host still answered after it was stopped. */
	| 'still-running'
	/** A file could not be removed. */
	| 'remove'
	/** The data directory could not be removed. */
	| 'purge';

export class RemoteHostStopError extends Error {
	readonly code: RemoteHostStopErrorCode;
	constructor(code: RemoteHostStopErrorCode, message: string) {
		super(message);
		this.name = 'RemoteHostStopError';
		this.code = code;
	}
}

export interface StopRemoteHostOptions {
	/** Also remove the service file and Maestro's own files under `~/.maestro`. */
	uninstall?: boolean;
	/** Stop even though the host holds agents. Never lets `purgeData` past them. */
	force?: boolean;
	/** Uninstall only: also remove the host's data directory. */
	purgeData?: boolean;
	/** Ceiling for each ssh call. Default 60 s for the survey, 60 s plus the stop wait for the act. */
	timeoutMs?: number;
	sshPath?: string;
	exec?: RemoteExec;
}

/** What `stopRemoteHost()` did, or why it changed nothing. */
export type RemoteHostStopResult =
	/** The desktop app on the remote is the host: quitting it there stops it. Nothing changed. */
	| { outcome: 'desktop-host'; survey: RemoteHostSurvey }
	/** The host holds agents (or they could not be read) and `force` was not given. Nothing changed. */
	| { outcome: 'agents-held'; survey: RemoteHostSurvey; agents: RemoteHostAgent[] | 'unknown' }
	/** `purgeData` was refused: the host holds agents, or the desktop app uses the directory. Nothing changed. */
	| {
			outcome: 'purge-refused';
			reason: 'agents-held' | 'desktop-data';
			survey: RemoteHostSurvey;
			agents?: RemoteHostAgent[] | 'unknown';
	  }
	/** Maestro left nothing there to stop or remove. */
	| { outcome: 'nothing'; survey: RemoteHostSurvey }
	| {
			outcome: 'done';
			survey: RemoteHostSurvey;
			/** A host was running and is stopped now. */
			hostStopped: boolean;
			/** The boot service no longer starts the host. */
			serviceDisabled: boolean;
			/** What was removed (uninstall only). */
			removed: string[];
			/** What was deliberately left: `~/.maestro/host.env`, a foreign `maestro-cli`, the data directory. */
			kept: string[];
			warnings: string[];
	  };

const DEFAULT_TIMEOUT_MS = 60_000;

function remoteLabel(remote: SshRemoteConfig): string {
	return remote.name || remote.host;
}

async function runScript(
	remote: SshRemoteConfig,
	script: string,
	timeout: number,
	options: StopRemoteHostOptions
): Promise<{ parsed: ParsedOutput; survey: RemoteHostSurvey; stderr: string }> {
	const exec =
		options.exec ?? ((command, args, opts) => execFileNoThrow(command, args, undefined, opts));
	const sshPath = options.sshPath ?? (await resolveSshPath());
	const label = remoteLabel(remote);
	const result = await exec(sshPath, buildRemoteScriptArgs(remote, script), { timeout });
	if (result.exitCode === 'ETIMEDOUT') {
		throw new RemoteHostStopError(
			'timeout',
			`No answer from ${label} within ${Math.round(timeout / 1000)}s.`
		);
	}
	const parsed = readMarkers(result.stdout);
	const survey = surveyFrom(parsed);
	if (!survey) {
		const detail = describeSshConnectionError(safeText(result.stderr));
		throw new RemoteHostStopError(
			'ssh-failed',
			`Could not reach Maestro's files on ${label}${detail ? `: ${detail}` : '.'}`
		);
	}
	return { parsed, survey, stderr: result.stderr };
}

function safeText(text: string): string {
	return redactSecrets(text, { hexBlobs: true }).text.trim();
}

/** Read what Maestro set up on `remote`, changing nothing. One ssh call. */
export async function surveyRemoteHost(
	remote: SshRemoteConfig,
	options: Pick<StopRemoteHostOptions, 'timeoutMs' | 'sshPath' | 'exec'> & { agents?: boolean } = {}
): Promise<RemoteHostSurvey> {
	const script = buildRemoteHostSurveyScript({ agents: options.agents });
	const { survey } = await runScript(
		remote,
		script,
		options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		options
	);
	return survey;
}

/**
 * Stop the host on `remote` and disable its boot service; with `uninstall`, also remove the
 * service file and Maestro's own install. The one implementation behind `remote-host stop`,
 * `remote-host uninstall`, and the desktop's Stop Host and Remove Host.
 *
 * A refusal (`desktop-host`, `agents-held`, `purge-refused`) resolves with nothing changed. Rejects
 * with a `RemoteHostStopError` when ssh failed or a step on the remote did.
 */
export async function stopRemoteHost(
	remote: SshRemoteConfig,
	options: StopRemoteHostOptions = {}
): Promise<RemoteHostStopResult> {
	const label = remoteLabel(remote);
	const surveyTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const survey = await surveyRemoteHost(remote, { ...options, agents: true });

	if (survey.host === 'desktop') return { outcome: 'desktop-host', survey };
	const uninstall = options.uninstall === true;
	if (
		survey.host === 'none' &&
		survey.service.kind === 'none' &&
		(!uninstall || !survey.hasFiles) &&
		!(uninstall && options.purgeData && survey.dataDir)
	) {
		return { outcome: 'nothing', survey };
	}

	const agents = survey.agents ?? 'unknown';
	const holds = agents === 'unknown' || agents.length > 0;
	if (uninstall && options.purgeData) {
		if (holds) return { outcome: 'purge-refused', reason: 'agents-held', survey, agents };
		if (survey.dataDirUsedByDesktop) {
			return { outcome: 'purge-refused', reason: 'desktop-data', survey };
		}
	}
	if (holds && !options.force) return { outcome: 'agents-held', survey, agents };

	const script = buildRemoteHostStopScript({ uninstall, purgeData: options.purgeData });
	const actTimeout = surveyTimeout + REMOTE_HOST_STOP_WAIT_SECONDS * 1000;
	const { parsed, survey: after, stderr } = await runScript(remote, script, actTimeout, options);
	const { markers } = parsed;
	if (first(markers, 'refused') === 'desktop') return { outcome: 'desktop-host', survey: after };

	const error = first(markers, 'error');
	if (error) {
		const detail = safeText(stderr);
		const message =
			error === 'host-stop'
				? `The host on ${label} did not stop${detail ? `: ${detail}` : '.'} Its boot service is disabled, so it does not come back after a reboot.`
				: error === 'still-running'
					? `The host on ${label} still answers after it was stopped. Stop it there with: maestro-cli host stop`
					: error === 'purge'
						? `The host's data directory on ${label} could not be removed${detail ? `: ${detail}` : '.'}`
						: `A file under ~/${REMOTE_INSTALL_ROOT} on ${label} could not be removed${detail ? `: ${detail}` : '.'}`;
		const code: RemoteHostStopErrorCode =
			error === 'host-stop' || error === 'still-running' || error === 'purge' ? error : 'remove';
		throw new RemoteHostStopError(code, message);
	}

	const did = markers.get('did') ?? [];
	const removed = markers.get('removed') ?? [];
	const kept = [...(markers.get('kept') ?? []), ...after.foreign];
	if (after.dataDir && !removed.includes(after.dataDir)) kept.push(after.dataDir);
	const warnings: string[] = [];
	if ((markers.get('warn') ?? []).includes('service-disable-failed')) {
		warnings.push(
			after.service.kind === 'launchd'
				? `launchd did not disable ${REMOTE_SERVICE_LABEL}: run \`launchctl disable gui/$(id -u)/${REMOTE_SERVICE_LABEL}\` on the remote.`
				: `systemd did not disable the user unit: run \`systemctl --user disable ${REMOTE_SERVICE_UNIT}\` on the remote.`
		);
	}
	const purgeRefusal = first(markers, 'refused');
	if (purgeRefusal === 'purge-desktop') {
		warnings.push(
			'The data directory was kept: the Maestro desktop app on the remote uses it too.'
		);
	} else if (purgeRefusal === 'purge-path') {
		warnings.push(
			'The data directory was kept: its path did not look like a Maestro data directory.'
		);
	}
	return {
		outcome: 'done',
		survey: after,
		hostStopped: did.includes('host-stopped'),
		serviceDisabled: did.includes('service-disabled'),
		removed,
		kept,
		warnings,
	};
}

/** The agents, as a person reads them: `3 agents: "A", "B", "C"`. */
export function describeHeldAgents(agents: RemoteHostAgent[] | 'unknown'): string {
	if (agents === 'unknown') return 'its agents could not be read';
	const names = agents.map((agent) => `"${agent.name}"`).join(', ');
	return `${agents.length} agent${agents.length === 1 ? '' : 's'}: ${names}`;
}

/** What the desktop-is-the-host refusal says. */
export function desktopHostMessage(remote: SshRemoteConfig, pid?: number): string {
	return (
		`The Maestro desktop app on ${remoteLabel(remote)}${pid ? ` (pid ${pid})` : ''} is the host there, and runs no service. ` +
		'Quit the app on that machine to stop it. Nothing was changed.'
	);
}
