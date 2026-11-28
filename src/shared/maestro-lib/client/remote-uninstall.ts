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
		'running=0; kind=unknown; pid=""',
		'if [ "$have" = 1 ]; then',
		'  ep=$(_mc host endpoint --json 2>/dev/null)',
		`  printf '%s\\n' "$ep" | grep -q '"running": *true' && running=1`,
		`  pid=$(printf '%s\\n' "$ep" | sed -n 's/^ *"pid": *\\([0-9][0-9]*\\).*/\\1/p' | head -n 1)`,
		'  ep=""',
		'  if [ "$running" = 1 ]; then',
		'    _ver=$(_mc version --json 2>/dev/null)',
		// A headless host names itself; the desktop app answers `get_app_info`. A CLI that says neither
		// (an earlier release) is not taken for the desktop app: the process decides.
		`    if printf '%s\\n' "$_ver" | grep -q '"hostKind": *"headless"'; then kind=headless`,
		`    elif printf '%s\\n' "$_ver" | grep -q '"appRunning": *true'; then kind=desktop`,
		'    elif [ -n "$pid" ]; then',
		'      case "$(ps -o args= -p "$pid" 2>/dev/null)" in',
		'        *maestro-cli*|*maestro-host-service*|*" host start"*|*" host run"*) kind=headless;;',
		'        *Maestro.app/Contents/MacOS/*|*[Ee]lectron*|*/maestro|*/maestro\\ *|*/Maestro|*/Maestro\\ *) kind=desktop;;',
		'      esac',
		'    fi',
		'    _ver=""',
		'  fi',
		'fi',
		'if [ "$running" = 0 ]; then say host=none; else say "host=$kind"; fi',
		'[ -n "$pid" ] && say "pid=$pid"',
		// The boot service.
		'service=none',
		'if [ "$os" = linux ]; then',
		'  [ -n "${XDG_RUNTIME_DIR:-}" ] || { [ -d "/run/user/$(id -u)" ] && export XDG_RUNTIME_DIR="/run/user/$(id -u)"; }',
		`  unit="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${REMOTE_SERVICE_UNIT}.service"`,
		// The link `enable` made: what starts the unit at boot, readable with no user bus.
		`  wants="\${unit%/*}/default.target.wants/${REMOTE_SERVICE_UNIT}.service"`,
		'  if [ -f "$unit" ]; then',
		'    service=systemd; say "service-file=$unit"',
		`    if systemctl --user is-enabled --quiet ${REMOTE_SERVICE_UNIT} 2>/dev/null || [ -e "$wants" ] || [ -L "$wants" ]; then say service-enabled=1; else say service-enabled=0; fi`,
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
		// The last survey line: output without it was cut off, and is never trusted.
		'say surveyed=1',
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
			// A running host is always asked: it may serve a data directory the guess above missed
			// (`--data-dir`, or MAESTRO_USER_DATA set outside host.env). No host and no data
			// directory: no agents. Anything that cannot be read: unknown, never "none".
			'if [ "$running" = 0 ] && [ ! -d "$data" ]; then say agents-begin; echo "[]"; say agents-end;',
			'elif [ "$have" = 0 ]; then say agents=unknown;',
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
	/** Stop a host the survey could not tell from the desktop app (`host=unknown`). */
	force?: boolean;
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
		`FORCE=${options.force ? 1 : 0}`,
		'[ "$running" = 1 ] && [ "$kind" = desktop ] && { say refused=desktop; exit 0; }',
		'[ "$running" = 1 ] && [ "$kind" = unknown ] && [ "$FORCE" = 0 ] && { say refused=unknown; exit 0; }',
		// 1. The service first, so nothing starts the host again behind the stop.
		'if [ "$service" = systemd ]; then',
		`  if systemctl --user disable ${REMOTE_SERVICE_UNIT} >/dev/null 2>&1; then say did=service-disabled`,
		// No user bus (no linger): `disable` cannot run, but the link it would remove is a plain file.
		'  else',
		'    rm -f "$wants" 2>/dev/null',
		'    if [ -e "$wants" ] || [ -L "$wants" ]; then say warn=service-disable-failed; else say did=service-disabled; fi',
		'  fi',
		'elif [ "$service" = launchd ]; then',
		`  if launchctl disable "$domain/${label}" >/dev/null 2>&1; then say did=service-disabled; ld_off=1; else say warn=service-disable-failed; fi`,
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
		// 4. Is the data directory safe to remove? Decided here, with the host stopped and the CLI
		// still in place: its real path is not home, an ancestor of home, or /; it holds Maestro's own
		// files and not the desktop app's; and it holds no agent now (one may have arrived since the
		// survey). Anything less keeps the data.
		'purge_ok=0',
		'if [ "$PURGE" = 1 ]; then',
		'  real=$(cd "$data" 2>/dev/null && pwd -P); home_real=$(cd "$HOME" 2>/dev/null && pwd -P)',
		'  under_home=0; case "$home_real/" in "$real/"*) under_home=1;; esac',
		'  if [ -z "$real" ] || [ "$real" = / ] || [ -z "$home_real" ] || [ "$under_home" = 1 ]; then say refused=purge-path',
		'  elif [ -f "$real/maestro-window-state.json" ]; then say refused=purge-desktop',
		'  elif [ ! -f "$real/maestro-settings.json" ] && [ ! -f "$real/maestro-sessions.json" ] && [ ! -f "$real/maestro-agent-configs.json" ]; then say refused=purge-path',
		'  elif [ "$have" = 0 ]; then say refused=purge-agents-unknown',
		'  elif ! _left=$(_mc list agents --json 2>/dev/null); then say refused=purge-agents-unknown',
		`  elif printf '%s\n' "$_left" | grep -q '"id"'; then say refused=purge-agents`,
		'  else purge_ok=1; fi',
		'fi',
		'if [ "$UNINSTALL" = 1 ]; then',
		'  if [ "$service" = systemd ]; then rm -f "$unit" && say "removed=$unit"; rm -f "$wants" 2>/dev/null; systemctl --user daemon-reload >/dev/null 2>&1; fi',
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
		'if [ "$purge_ok" = 1 ]; then',
		'  if rm -rf "$real"; then say "removed=$data"; else say error=purge; exit 0; fi',
		'fi',
		// The last check: does anything still start the host at boot (systemd) or login (launchd)?
		'boot=off',
		'[ "$service" = systemd ] && [ -f "$unit" ] && { [ -e "$wants" ] || [ -L "$wants" ]; } && boot=on',
		'[ "$service" = launchd ] && [ -f "$plist" ] && [ "${ld_off:-0}" != 1 ] && boot=on',
		'[ "$service" != none ] && say "boot=$boot"',
		'say done',
		'exit 0',
	];
	return lines.join('\n');
}

/**
 * Who answers for the host on the remote. `unknown`: a host runs, but neither its CLI nor its
 * process says whether it is the desktop app or a headless host (an earlier release).
 */
export type RemoteHostKind = 'none' | 'headless' | 'desktop' | 'unknown';

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

/** Control characters (C0, DEL, C1): a remote's agent name must not drive the local terminal. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * `list agents --json` rows (an array, or one object per line), reduced to id and name. Both come
 * from the remote and are printed here, so their control characters are dropped.
 */
export function parseRemoteAgentList(raw: string): RemoteHostAgent[] | null {
	const toAgent = (row: unknown): RemoteHostAgent | null => {
		if (!row || typeof row !== 'object') return null;
		const { id, name } = row as Record<string, unknown>;
		if (typeof id !== 'string' || !id) return null;
		const cleanId = id.replace(CONTROL_CHARS, '');
		const cleanName = typeof name === 'string' ? name.replace(CONTROL_CHARS, '').trim() : '';
		return { id: cleanId || id, name: cleanName || cleanId || '(unnamed)' };
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
	if (!os || !serviceKind || first(markers, 'surveyed') !== '1') return null;
	const hostRaw = first(markers, 'host');
	const host: RemoteHostKind =
		hostRaw === 'headless' || hostRaw === 'desktop' || hostRaw === 'unknown' ? hostRaw : 'none';
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
	| 'purge'
	/** The connection ended before the remote said it was done. */
	| 'incomplete';

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
	/**
	 * Stop even though the host holds agents (or they could not be read), or a host runs that could
	 * not be told from the desktop app. Never lets `purgeData` past agents.
	 */
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
	/** A host runs that could not be told from the desktop app, and `force` was not given. Nothing changed. */
	| { outcome: 'host-unknown'; survey: RemoteHostSurvey }
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
			/** `purgeData` only: the data directory is gone. False when the last check kept it. */
			purged: boolean;
			/**
			 * The boot service could not be disabled (no systemd user bus, a launchd domain error):
			 * the host comes back at boot or login. The CLI exits non-zero and Stop Host fails on it.
			 */
			serviceLeftAtBoot: boolean;
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
	if (survey.host === 'unknown' && !options.force) return { outcome: 'host-unknown', survey };
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

	const script = buildRemoteHostStopScript({
		uninstall,
		purgeData: options.purgeData,
		force: options.force,
	});
	const actTimeout = surveyTimeout + REMOTE_HOST_STOP_WAIT_SECONDS * 1000;
	const { parsed, survey: after, stderr } = await runScript(remote, script, actTimeout, options);
	const { markers } = parsed;
	if (first(markers, 'refused') === 'desktop') return { outcome: 'desktop-host', survey: after };
	if (first(markers, 'refused') === 'unknown') return { outcome: 'host-unknown', survey: after };

	const did = markers.get('did') ?? [];
	// The script's last check (`boot=`) when it got that far; before it, whether `disable` worked.
	const boot = first(markers, 'boot');
	const serviceLeftAtBoot =
		after.service.kind !== 'none' &&
		(boot !== undefined ? boot === 'on' : !did.includes('service-disabled'));
	const error = first(markers, 'error');
	if (error) {
		const detail = safeText(stderr);
		const bootNote =
			after.service.kind === 'none'
				? ''
				: serviceLeftAtBoot
					? ` ${serviceLeftAtBootMessage(after.service.kind)}`
					: ' Its boot service is disabled, so it does not come back after a reboot.';
		const message =
			error === 'host-stop'
				? `The host on ${label} did not stop${detail ? `: ${detail}` : '.'}${bootNote}`
				: error === 'still-running'
					? `The host on ${label} still answers after it was stopped. Stop it there with: maestro-cli host stop${bootNote}`
					: error === 'purge'
						? `The host's data directory on ${label} could not be removed${detail ? `: ${detail}` : '.'}`
						: `A file under ~/${REMOTE_INSTALL_ROOT} on ${label} could not be removed${detail ? `: ${detail}` : '.'}${bootNote}`;
		const code: RemoteHostStopErrorCode =
			error === 'host-stop' || error === 'still-running' || error === 'purge' ? error : 'remove';
		throw new RemoteHostStopError(code, message);
	}

	// Every finished run ends with `done`. Without it the connection dropped part way, and what was
	// stopped or removed is not known: never report that as success.
	if (!markers.has('done')) {
		throw new RemoteHostStopError(
			'incomplete',
			`The connection to ${label} ended before the ${uninstall ? 'removal' : 'stop'} finished. Run \`maestro-cli remote-host status ${remote.name || remote.id}\` to see what is left, then run it again.`
		);
	}
	const removed = markers.get('removed') ?? [];
	const kept = [...(markers.get('kept') ?? []), ...after.foreign];
	if (after.dataDir && !removed.includes(after.dataDir)) kept.push(after.dataDir);
	const warnings: string[] = [];
	if (serviceLeftAtBoot && after.service.kind !== 'none') {
		warnings.push(serviceLeftAtBootMessage(after.service.kind));
	}
	const purgeRefusal = first(markers, 'refused');
	if (purgeRefusal === 'purge-desktop') {
		warnings.push(
			'The data directory was kept: the Maestro desktop app on the remote uses it too.'
		);
	} else if (purgeRefusal === 'purge-path') {
		warnings.push(
			'The data directory was kept: it is not a Maestro data directory, or it is your home folder or one above it.'
		);
	} else if (purgeRefusal === 'purge-agents') {
		warnings.push('The data directory was kept: an agent appeared on the host while it stopped.');
	} else if (purgeRefusal === 'purge-agents-unknown') {
		warnings.push(
			'The data directory was kept: its agents could not be read to make sure it holds none.'
		);
	}
	return {
		outcome: 'done',
		survey: after,
		hostStopped: did.includes('host-stopped'),
		serviceDisabled: did.includes('service-disabled'),
		removed,
		kept,
		purged: after.dataDir !== undefined && removed.includes(after.dataDir),
		serviceLeftAtBoot,
		warnings,
	};
}

/** What a boot service that could not be disabled means, and the command that disables it. */
export function serviceLeftAtBootMessage(kind: 'systemd' | 'launchd'): string {
	return kind === 'launchd'
		? `Its boot service could not be disabled, so the host comes back at the next login. Run \`launchctl disable gui/$(id -u)/${REMOTE_SERVICE_LABEL}\` on the remote.`
		: `Its boot service could not be disabled, so the host comes back at the next boot. Run \`systemctl --user disable ${REMOTE_SERVICE_UNIT}\` on the remote (it needs a user session: \`loginctl enable-linger\`, or log in there).`;
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

/**
 * One paragraph for a person, for every outcome: what changed, or why nothing did. The desktop's
 * Stop Host and Remove Host show it; the CLI prints its refusals with it.
 */
export function describeRemoteHostStop(
	remote: SshRemoteConfig,
	result: RemoteHostStopResult,
	uninstall: boolean
): string {
	const label = remoteLabel(remote);
	switch (result.outcome) {
		case 'desktop-host':
			return desktopHostMessage(remote, result.survey.pid);
		case 'host-unknown':
			return (
				`A Maestro host runs on ${label}${result.survey.pid ? ` (pid ${result.survey.pid})` : ''}, but it could not be told whether it is the desktop app or a headless host. ` +
				'Nothing was changed.'
			);
		case 'agents-held':
			return (
				`The host on ${label} holds ${describeHeldAgents(result.agents)}. Nothing was changed. ` +
				'Move them back first. Stopping the host anyway leaves them behind on the remote: their data stays there, and nothing runs them.'
			);
		case 'purge-refused':
			return result.reason === 'desktop-data'
				? `The host's data was kept: the Maestro desktop app on ${label} uses that data directory too (${result.survey.dataDir ?? 'unknown'}). Nothing was changed.`
				: `The host's data was kept: the host on ${label} holds ${describeHeldAgents(result.agents ?? 'unknown')}, and it is their only copy until they move back. Nothing was changed.`;
		case 'nothing':
			return uninstall
				? `Maestro installed nothing on ${label} to remove: no host, no boot service, no files under ~/${REMOTE_INSTALL_ROOT}.`
				: `No host runs on ${label} and no boot service is registered: nothing to stop.`;
		case 'done': {
			const parts = [
				result.hostStopped
					? `The host on ${label} is stopped.`
					: `No host was running on ${label}.`,
			];
			if (result.serviceDisabled) {
				parts.push('Its boot service is disabled, so it does not come back after a reboot.');
			}
			if (uninstall) {
				parts.push(
					result.removed.length
						? `Removed ${result.removed.length} item${result.removed.length === 1 ? '' : 's'} Maestro installed.`
						: 'Nothing was left to remove.'
				);
			}
			if (result.kept.length) parts.push(`Kept: ${result.kept.join(', ')}.`);
			parts.push(...result.warnings);
			return parts.join(' ');
		}
	}
}
