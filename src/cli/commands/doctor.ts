// Doctor command - diagnose the CLI's connection to the Maestro desktop app and
// surface the most common failure modes as a checklist:
//   - is the app running and reachable (discovery file + PID + live ping)?
//   - does the running app's build match this CLI's version (skew detection)?
//   - does the running app understand newer commands, or is it an older build?
//   - are the configured SSH remotes well-formed?
//
// Designed to answer "why isn't my CLI command working?" in one shot, including
// the rebuild-skew trap where a freshly-built CLI talks to an older still-running
// app (same version string, missing handlers).

import { readCliServerInfo, isCliServerRunning } from '../../shared/cli-server-discovery';
import { readSshRemotes } from '../services/storage';
import { MaestroClient, UnsupportedCommandError } from '../services/maestro-client';
import { colorize } from '../output/formatter';
import { ExitCode } from '../exit-codes';

type CheckStatus = 'ok' | 'warn' | 'fail';

interface Check {
	label: string;
	status: CheckStatus;
	detail?: string;
}

interface DoctorOptions {
	json?: boolean;
}

function symbol(status: CheckStatus): string {
	if (status === 'ok') return colorize('green', '✓');
	if (status === 'warn') return colorize('yellow', '⚠');
	return colorize('red', '✗');
}

/**
 * Run the diagnostic checks. `cliVersion` is the CLI's own build version
 * (injected at build time in index.ts) so we can compare it against the app's.
 */
export async function doctor(cliVersion: string, options: DoctorOptions): Promise<void> {
	const checks: Check[] = [];

	// 1. Discovery file present.
	const info = readCliServerInfo();
	if (!info) {
		checks.push({
			label: 'Desktop app running',
			status: 'fail',
			detail: 'No discovery file found. Start the Maestro desktop app.',
		});
		return report(checks, cliVersion, null, options, ExitCode.NotRunning);
	}
	checks.push({ label: 'Discovery file present', status: 'ok', detail: `port ${info.port}` });

	// 2. PID alive.
	if (!isCliServerRunning()) {
		checks.push({
			label: 'App process alive',
			status: 'fail',
			detail: 'Discovery file is stale (the app may have crashed). Restart Maestro.',
		});
		return report(checks, cliVersion, info.version ?? null, options, ExitCode.NotRunning);
	}
	checks.push({ label: 'App process alive', status: 'ok', detail: `pid ${info.pid}` });

	// 3. Version skew. The discovery file records the running build's version.
	// A missing value means the app predates version stamping (an older build).
	if (!info.version) {
		checks.push({
			label: 'Version match',
			status: 'warn',
			detail: `App did not report a version (older build); CLI is ${cliVersion}. Rebuild and restart the app.`,
		});
	} else if (info.version !== cliVersion) {
		checks.push({
			label: 'Version match',
			status: 'warn',
			detail: `App is ${info.version} but CLI is ${cliVersion}. Rebuild/restart whichever is behind.`,
		});
	} else {
		checks.push({ label: 'Version match', status: 'ok', detail: cliVersion });
	}

	// 4. Live reachability (ping) + new-handler support probe. The probe sends a
	// recent message type; an UnsupportedCommandError means the running app is an
	// older build than this CLI (the rebuild-skew trap).
	const client = new MaestroClient();
	try {
		await client.connect();
		await client.sendCommand<{ type: string }>({ type: 'ping' }, 'pong');
		checks.push({ label: 'WebSocket reachable', status: 'ok' });

		try {
			// get_settings is a long-standing read; if even this echoes back, the
			// app is very old. Use it as the support probe.
			await client.sendCommand<{ type: string }>({ type: 'get_settings' }, 'settings');
			checks.push({ label: 'App handles commands', status: 'ok' });
		} catch (probeErr) {
			if (probeErr instanceof UnsupportedCommandError) {
				checks.push({
					label: 'App handles commands',
					status: 'warn',
					detail: 'Running app is missing expected handlers (older build). Rebuild and restart.',
				});
			} else {
				checks.push({
					label: 'App handles commands',
					status: 'warn',
					detail: probeErr instanceof Error ? probeErr.message : String(probeErr),
				});
			}
		}
	} catch (err) {
		checks.push({
			label: 'WebSocket reachable',
			status: 'fail',
			detail: err instanceof Error ? err.message : String(err),
		});
	} finally {
		client.disconnect();
	}

	// 5. SSH remote config sanity (reads the settings store directly; no app
	// needed). Flags remotes missing a host, or missing auth when not using
	// ~/.ssh/config.
	const remotes = readSshRemotes();
	if (remotes.length === 0) {
		checks.push({ label: 'SSH remotes', status: 'ok', detail: 'none configured' });
	} else {
		const broken = remotes.filter((r) => {
			if (!r.host || r.host.trim() === '') return true;
			// When not delegating to ~/.ssh/config, a username is required to spawn.
			if (!r.useSshConfig && (!r.username || r.username.trim() === '')) return true;
			return false;
		});
		if (broken.length === 0) {
			checks.push({
				label: 'SSH remotes',
				status: 'ok',
				detail: `${remotes.length} configured, all well-formed`,
			});
		} else {
			checks.push({
				label: 'SSH remotes',
				status: 'warn',
				detail: `${broken.length} of ${remotes.length} incomplete: ${broken.map((r) => r.name).join(', ')}`,
			});
		}
	}

	const exitCode = checks.some((ch) => ch.status === 'fail')
		? ExitCode.NotRunning
		: ExitCode.Success;
	return report(checks, cliVersion, info.version ?? null, options, exitCode);
}

function report(
	checks: Check[],
	cliVersion: string,
	appVersion: string | null,
	options: DoctorOptions,
	exitCode: ExitCode
): void {
	if (options.json) {
		console.log(
			JSON.stringify({
				ok: exitCode === ExitCode.Success,
				cliVersion,
				appVersion,
				checks: checks.map((ch) => ({ label: ch.label, status: ch.status, detail: ch.detail })),
			})
		);
	} else {
		for (const ch of checks) {
			console.log(`  ${symbol(ch.status)} ${ch.label}${ch.detail ? ` - ${ch.detail}` : ''}`);
		}
	}
	if (exitCode !== ExitCode.Success) {
		process.exit(exitCode);
	}
}
