// Version command - report the running Maestro desktop app's version and the git
// commit hash it was built from (the same hash shown in the About modal), plus the
// CLI's own version. Queries the app over the WebSocket bridge (get_app_info).
// A headless host (`maestro-cli host`) has no app to ask; its version is the one
// it wrote into the discovery file.

import { readCliServerInfo, isCliServerRunning } from '../../shared/cli-server-discovery';
import { withMaestroClient } from '../services/maestro-client';
import { ExitCode, exitWith } from '../exit-codes';
import { NOT_RUNNING_MESSAGE } from './status';

interface AppInfoResponse {
	type: string;
	version?: string;
	commitHash?: string;
	platform?: string;
}

interface VersionOptions {
	json?: boolean;
}

export async function version(cliVersion: string, options: VersionOptions = {}): Promise<void> {
	const info = readCliServerInfo();
	const running = !!info && isCliServerRunning();

	if (!running) {
		// The app isn't reachable - still report the CLI's own version rather than fail.
		if (options.json) {
			console.log(JSON.stringify({ cliVersion, appRunning: false }, null, 2));
		} else {
			console.log(`maestro-cli ${cliVersion}`);
			console.log(NOT_RUNNING_MESSAGE);
		}
		exitWith(ExitCode.NotRunning);
	}

	// The headless host serves no `get_app_info`: it is a build of the CLI, not
	// of the app, and says which in the discovery file it wrote.
	if (info?.hostKind === 'headless') {
		const hostVersion = info.version ?? 'unknown';
		if (options.json) {
			console.log(
				JSON.stringify(
					{ cliVersion, appRunning: false, hostKind: 'headless', hostVersion, hostPid: info.pid },
					null,
					2
				)
			);
		} else {
			console.log(`maestro-cli   ${cliVersion}`);
			console.log(`Maestro host  ${hostVersion} (headless, pid ${info.pid})`);
		}
		return;
	}

	try {
		await withMaestroClient(async (client) => {
			const res = await client.sendCommand<AppInfoResponse>({ type: 'get_app_info' }, 'app_info');
			const appVersion = res.version ?? 'unknown';
			const commitHash = res.commitHash || '';

			if (options.json) {
				console.log(
					JSON.stringify(
						{
							cliVersion,
							appRunning: true,
							appVersion,
							commitHash,
							platform: res.platform,
						},
						null,
						2
					)
				);
				return;
			}

			console.log(`maestro-cli   ${cliVersion}`);
			console.log(`Maestro app   ${appVersion}${commitHash ? ` (${commitHash})` : ''}`);
			if (!commitHash) {
				console.log('(commit hash unavailable for this build)');
			}
		});
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		exitWith(ExitCode.NotRunning);
	}
}
