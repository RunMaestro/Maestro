/**
 * Keeping a Federation host running on an SSH remote across reboots and logouts.
 *
 * `remote-host install` (`remote-install.ts`) puts `maestro-cli` in `~/.maestro`; this module
 * registers its host with the remote's own service manager, as the SSH user, over ONE ssh call:
 *
 * | Remote                         | Service                                                          |
 * | ------------------------------ | ---------------------------------------------------------------- |
 * | Linux with a systemd user bus  | `~/.config/systemd/user/maestro-host.service`, enabled; lingering turned on when the user may |
 * | macOS without Maestro.app      | `~/Library/LaunchAgents/sh.maestro.host.plist`, loaded           |
 * | macOS WITH Maestro.app         | none: the desktop app is the host while it runs, and a headless host would lock it out |
 * | Windows, or Linux without a user bus | none, with the reason and what to do by hand              |
 *
 * Both service files run `~/.maestro/bin/maestro-host-service`, a wrapper that sets up the same
 * PATH an SSH agent spawn gets (`wrapRemoteCommandWithPath()`: `~/.maestro/bin`, `~/.local/bin`,
 * the Node version managers) and then `exec`s `maestro-cli host start --foreground`, so the host
 * finds the provider CLIs the SSH agents already used.
 *
 * A host that already runs detached (`host start`) is never stopped here: the service is enabled
 * (`deferred`) and takes over at the next boot. Starting the service beside it would only make the
 * service manager restart a host that cannot take the data directory's lock.
 *
 * Nothing asks for sudo. When lingering cannot be turned on without it, the report says so and
 * carries the one command a person has to run.
 */

import { redactSecrets } from '../../redactSecrets';
import { describeSshConnectionError } from '../../sshConnection';
import type { SshRemoteConfig } from '../../types';
import { execFileNoThrow } from '../launch/exec-file';
import { wrapRemoteCommandWithPath } from '../launch/ssh-command-builder';
import { resolveSshPath } from '../launch/ssh-path';
import { buildRemoteScriptArgs, type RemoteExec } from './remote-discovery';

/** The systemd unit name, and the launchd label. */
export const REMOTE_SERVICE_UNIT = 'maestro-host';
export const REMOTE_SERVICE_LABEL = 'sh.maestro.host';

const MARKER = 'MAESTRO_SERVICE=';

/** Which service manager runs the host, or `none`. */
export type RemoteServiceKind = 'systemd' | 'launchd' | 'none';

/**
 * - `started`: the service started the host now.
 * - `active`: the service already runs the host.
 * - `deferred`: enabled, and a host started some other way runs now; the service takes over at
 *   the next boot.
 * - `start-failed`: enabled, but the start did not come up (see the service's log).
 */
export type RemoteServiceState = 'started' | 'active' | 'deferred' | 'start-failed';

/** Why there is no service, each with the fix a person can apply. */
export type RemoteServiceSkipReason =
	| 'no-launcher'
	| 'write-failed'
	| 'no-systemd-user'
	| 'enable-failed'
	| 'desktop-app'
	| 'unsupported-os';

export type RemoteServiceReport =
	| {
			kind: 'systemd' | 'launchd';
			state: RemoteServiceState;
			/** Linux: lingering is on, so the host survives logout and starts at boot. */
			linger?: boolean;
			/** Linux, lingering off and not ours to turn on: the command to run (needs sudo). */
			lingerFix?: string;
			/** What a person still has to do for the host to come back after a reboot, if anything. */
			note?: string;
	  }
	| { kind: 'none'; reason: RemoteServiceSkipReason; fix: string };

/** The fix for each reason there is no service, for a person to act on. */
export function remoteServiceSkipFix(reason: RemoteServiceSkipReason): string {
	switch (reason) {
		case 'no-launcher':
			return 'Install maestro-cli there first: maestro-cli remote-host install <ssh-remote>.';
		case 'write-failed':
			return 'Maestro could not write under ~/.maestro or the service folder. Check the home directory is writable by the SSH user.';
		case 'no-systemd-user':
			return 'This Linux remote has no systemd user session (a container, or WSL without systemd). Start the host from your own init (run `~/.maestro/bin/maestro-host-service`), or restart it with Start Host after each reboot.';
		case 'enable-failed':
			return 'systemd refused to enable the user unit. Run `systemctl --user enable --now maestro-host` on the remote to see why.';
		case 'desktop-app':
			return 'Maestro.app is installed on this Mac, and it is the host while it runs. Keep the app open (add it to Login Items) for its agents to keep working.';
		case 'unsupported-os':
			return 'Windows has no service Maestro can register without admin rights. Run `~/.maestro/bin/maestro-host-service` from a Task Scheduler task "At log on", or use Start Host after each reboot.';
	}
}

/** The launchd note: a LaunchAgent runs only once the user logs in. */
export const LAUNCHD_LOGIN_NOTE =
	'macOS starts this host when you log in to the Mac. On a headless Mac, turn on automatic login so it comes back after a reboot.';

const SKIP_REASONS: ReadonlySet<string> = new Set<RemoteServiceSkipReason>([
	'no-launcher',
	'write-failed',
	'no-systemd-user',
	'enable-failed',
	'desktop-app',
	'unsupported-os',
]);

/** The wrapper both service files run: the agent-spawn PATH, then the host in the foreground. */
export function buildHostServiceWrapper(): string {
	return [
		'#!/bin/sh',
		'# Written by Maestro (Federation): runs the host in the foreground for the service manager.',
		`exec ${wrapRemoteCommandWithPath('exec "$HOME/.maestro/bin/maestro-cli" host start --foreground')}`,
		'',
	].join('\n');
}

/** The systemd user unit. `%h` is the home directory. */
export function buildSystemdUnit(): string {
	return [
		'[Unit]',
		'Description=Maestro headless host (Federation)',
		'After=network-online.target',
		'',
		'[Service]',
		'Type=simple',
		'ExecStart=%h/.maestro/bin/maestro-host-service',
		'Restart=on-failure',
		'RestartSec=10',
		// Above the host's default --stop-grace (30 s), so a stop drains before SIGKILL.
		'TimeoutStopSec=90',
		'',
		'[Install]',
		'WantedBy=default.target',
		'',
	].join('\n');
}

/** The launchd agent. launchd expands neither `~` nor `$HOME`, so the script fills the path in. */
export function buildLaunchdPlist(wrapperPath: string): string {
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		'<dict>',
		`\t<key>Label</key><string>${REMOTE_SERVICE_LABEL}</string>`,
		`\t<key>ProgramArguments</key><array><string>${wrapperPath}</string></array>`,
		'\t<key>RunAtLoad</key><true/>',
		'\t<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
		'\t<key>ThrottleInterval</key><integer>10</integer>',
		'\t<key>ExitTimeOut</key><integer>40</integer>',
		'</dict>',
		'</plist>',
		'',
	].join('\n');
}

/**
 * The POSIX shell script that registers the host's service. Prints `MAESTRO_SERVICE=` markers:
 * `kind=`, then `state=` (or `reason=`), and on Linux `linger=on|off` with `lingerFix=`. Always
 * exits 0 when it ran: a missing service is a report, not a failure.
 */
export function buildRemoteServiceScript(): string {
	const wrapper = buildHostServiceWrapper();
	const unit = buildSystemdUnit();
	// The plist needs the absolute wrapper path; `__WRAPPER__` is replaced by the script.
	const plist = buildLaunchdPlist('__WRAPPER__');
	return [
		`M='${MARKER}'`,
		`say() { printf '%s%s\\n' "$M" "$1"; }`,
		'skip() { say kind=none; say "reason=$1"; exit 0; }',
		'bin="$HOME/.maestro/bin"; launcher="$bin/maestro-cli"; wrapper="$bin/maestro-host-service"',
		'[ -x "$launcher" ] || skip no-launcher',
		'case "$(uname -s)" in Linux*) os=linux;; Darwin*) os=darwin;; *) os=other;; esac',
		'[ "$os" = other ] && skip unsupported-os',
		// The desktop app is the host on a Mac that has it: a headless host would lock it out.
		'[ "$os" = darwin ] && [ -d /Applications/Maestro.app ] && skip desktop-app',
		'mkdir -p "$bin" || skip write-failed',
		`cat > "$wrapper.new" <<'MAESTRO_HOST_SERVICE' || skip write-failed`,
		wrapper.trimEnd(),
		'MAESTRO_HOST_SERVICE',
		'{ chmod 755 "$wrapper.new" && mv -f "$wrapper.new" "$wrapper"; } || skip write-failed',
		// Is a host already serving the data directory (however it was started)?
		`running=0; "$launcher" host status --json 2>/dev/null | grep -q '"running": *true' && running=1`,
		'me=$(id -un)',
		'if [ "$os" = linux ]; then',
		'  [ -n "${XDG_RUNTIME_DIR:-}" ] || { [ -d "/run/user/$(id -u)" ] && export XDG_RUNTIME_DIR="/run/user/$(id -u)"; }',
		'  { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; } || skip no-systemd-user',
		'  unitdir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"',
		'  mkdir -p "$unitdir" || skip write-failed',
		`  cat > "$unitdir/${REMOTE_SERVICE_UNIT}.service" <<'MAESTRO_UNIT' || skip write-failed`,
		unit.trimEnd(),
		'MAESTRO_UNIT',
		`  { systemctl --user daemon-reload && systemctl --user enable ${REMOTE_SERVICE_UNIT} >/dev/null 2>&1; } || skip enable-failed`,
		'  say kind=systemd',
		// Lingering keeps user services alive after logout and starts them at boot. A user may turn
		// it on for themselves on most systems; where polkit says no, a person runs it with sudo.
		'  linger=$(loginctl show-user "$me" -p Linger --value 2>/dev/null)',
		'  [ "$linger" = yes ] || { loginctl enable-linger "$me" >/dev/null 2>&1 && linger=yes; }',
		'  if [ "$linger" = yes ]; then say linger=on; else say linger=off; say "lingerFix=sudo loginctl enable-linger $me"; fi',
		'  if [ "$running" = 1 ]; then',
		`    if systemctl --user is-active --quiet ${REMOTE_SERVICE_UNIT}; then say state=active; else say state=deferred; fi`,
		`  elif systemctl --user start ${REMOTE_SERVICE_UNIT} >/dev/null 2>&1; then say state=started;`,
		'  else say state=start-failed; fi',
		'  exit 0',
		'fi',
		// macOS
		`plist="$HOME/Library/LaunchAgents/${REMOTE_SERVICE_LABEL}.plist"`,
		'mkdir -p "$HOME/Library/LaunchAgents" || skip write-failed',
		`cat > "$plist.new" <<'MAESTRO_PLIST' || skip write-failed`,
		plist.trimEnd(),
		'MAESTRO_PLIST',
		// launchd expands nothing: put the absolute wrapper path in.
		'sed "s#__WRAPPER__#$wrapper#" "$plist.new" > "$plist" && rm -f "$plist.new" || skip write-failed',
		'say kind=launchd',
		'uid=$(id -u); domain="gui/$uid"; launchctl print "$domain" >/dev/null 2>&1 || domain="user/$uid"',
		`if launchctl print "$domain/${REMOTE_SERVICE_LABEL}" >/dev/null 2>&1; then`,
		'  if [ "$running" = 1 ]; then say state=active;',
		`  elif launchctl kickstart "$domain/${REMOTE_SERVICE_LABEL}" >/dev/null 2>&1; then say state=started; else say state=start-failed; fi`,
		// Loading it now would start a second host beside the running one: it loads at next login.
		'elif [ "$running" = 1 ]; then say state=deferred;',
		'elif launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1; then say state=started;',
		'else say state=start-failed; fi',
		'exit 0',
	].join('\n');
}

/** The `key=value` markers the script printed. */
export function readServiceMarkers(stdout: string): Map<string, string> {
	const markers = new Map<string, string>();
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.startsWith(MARKER)) continue;
		const body = line.slice(MARKER.length).trim();
		const at = body.indexOf('=');
		if (at !== -1) markers.set(body.slice(0, at), body.slice(at + 1));
	}
	return markers;
}

/** Turn the script's markers into a report, or null when the script did not run. */
export function parseRemoteServiceReport(stdout: string): RemoteServiceReport | null {
	const markers = readServiceMarkers(stdout);
	const kind = markers.get('kind');
	if (kind === 'none') {
		const raw = markers.get('reason') ?? '';
		const reason = (SKIP_REASONS.has(raw) ? raw : 'write-failed') as RemoteServiceSkipReason;
		return { kind: 'none', reason, fix: remoteServiceSkipFix(reason) };
	}
	if (kind !== 'systemd' && kind !== 'launchd') return null;
	const rawState = markers.get('state');
	const state: RemoteServiceState =
		rawState === 'started' ||
		rawState === 'active' ||
		rawState === 'deferred' ||
		rawState === 'start-failed'
			? rawState
			: 'start-failed';
	const linger = markers.get('linger');
	const lingerFix = markers.get('lingerFix');
	return {
		kind,
		state,
		...(linger === 'on' ? { linger: true } : linger === 'off' ? { linger: false } : {}),
		...(linger === 'off' && lingerFix && /^sudo loginctl enable-linger [\w.@-]+$/.test(lingerFix)
			? { lingerFix }
			: {}),
		...(kind === 'launchd' ? { note: LAUNCHD_LOGIN_NOTE } : {}),
	};
}

export class RemoteServiceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RemoteServiceError';
	}
}

export interface InstallRemoteServiceOptions {
	timeoutMs?: number;
	sshPath?: string;
	exec?: RemoteExec;
}

/**
 * Register the host on `remote` with its service manager over one ssh call, and start it through
 * the service when no host runs. Rejects only when ssh itself failed; a remote with no usable
 * service manager resolves to `{ kind: 'none', reason, fix }`.
 */
export async function installRemoteService(
	remote: SshRemoteConfig,
	options: InstallRemoteServiceOptions = {}
): Promise<RemoteServiceReport> {
	const timeout = options.timeoutMs ?? 60_000;
	const exec =
		options.exec ?? ((command, args, opts) => execFileNoThrow(command, args, undefined, opts));
	const sshPath = options.sshPath ?? (await resolveSshPath());
	const label = remote.name || remote.host;
	const result = await exec(sshPath, buildRemoteScriptArgs(remote, buildRemoteServiceScript()), {
		timeout,
	});
	if (result.exitCode === 'ETIMEDOUT') {
		throw new RemoteServiceError(
			`Registering the host service on ${label} did not answer within ${Math.round(timeout / 1000)}s.`
		);
	}
	const report = parseRemoteServiceReport(result.stdout);
	if (!report) {
		const detail = describeSshConnectionError(
			redactSecrets(result.stderr, { hexBlobs: true }).text.trim()
		);
		throw new RemoteServiceError(
			`Could not register the host service on ${label}${detail ? `: ${detail}` : '.'}`
		);
	}
	return report;
}

/** One line for a person: what the service does now, and anything they still have to do. */
export function describeRemoteService(report: RemoteServiceReport): string {
	if (report.kind === 'none') return `No service: ${report.fix}`;
	const manager = report.kind === 'systemd' ? 'systemd user service' : 'launchd agent';
	const state =
		report.state === 'started'
			? 'started the host'
			: report.state === 'active'
				? 'runs the host'
				: report.state === 'deferred'
					? 'enabled; it takes over from the running host at the next boot'
					: 'enabled, but the host did not start through it';
	const extras = [
		report.lingerFix
			? `Lingering is off, so the host stops when you log out and does not start at boot: run \`${report.lingerFix}\` on the remote.`
			: '',
		report.note ?? '',
	].filter(Boolean);
	return [`${manager}: ${state}.`, ...extras].join(' ');
}
