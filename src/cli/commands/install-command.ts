// Install-command command - print the one-line install for a provider CLI.
//
// The CLI half of the agent error dialog's "Install <provider>" action. The
// desktop runs the same command in an embedded terminal; an agent driving
// Maestro already has a shell, so what it needs is the command itself, for the
// platform it is on. Reads the same table as the dialog (`shared/agentInstall`),
// so the two cannot offer different installs.

import { getAgentInstallInfo, toInstallPlatform } from '../../shared/agentInstall';
import { AGENT_IDS } from '../../shared/agentIds';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { ExitCode } from '../exit-codes';

interface InstallCommandOptions {
	platform?: string;
	json?: boolean;
}

export function installCommand(provider: string, options: InstallCommandOptions): void {
	const platform = toInstallPlatform(options.platform ?? process.platform);
	if (!platform) {
		console.error(
			`Error: unsupported platform "${options.platform ?? process.platform}". Use darwin, linux, or win32.`
		);
		process.exit(ExitCode.InvalidUsage);
	}

	if (!(AGENT_IDS as readonly string[]).includes(provider)) {
		console.error(
			`Error: unknown provider "${provider}". Known providers: ${AGENT_IDS.filter((id) => id !== 'terminal').join(', ')}`
		);
		process.exit(ExitCode.InvalidUsage);
	}

	const info = getAgentInstallInfo(provider);
	const command = info?.commands[platform] ?? null;

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					provider,
					name: getAgentDisplayName(provider),
					platform,
					command,
					docsUrl: info?.docsUrl ?? null,
				},
				null,
				2
			)
		);
		if (!command) process.exit(ExitCode.GeneralError);
		return;
	}

	if (!command) {
		console.error(
			`No one-line install for ${getAgentDisplayName(provider)} on ${platform}.` +
				(info ? ` See ${info.docsUrl}` : '')
		);
		process.exit(ExitCode.GeneralError);
	}

	console.log(command);
}
