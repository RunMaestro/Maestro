import type { Command } from 'commander';
import { readFile } from 'fs/promises';
import { sendLiteCommand } from '../services/lite-client';
import { resolveCliPath } from '../utils/parse';
import type { LiteControlAction } from '../../shared/lite-control';

/** Native connection controls always return readable JSON, including read-after-write state. */
export function registerLiteCommands(program: Command): void {
	const lite = program
		.command('lite')
		.description(
			'Control a running isolated Maestro Lite client through its native connection actions (JSON output)'
		)
		.option(
			'--user-data <path>',
			'Final isolated Lite user-data directory (same as Maestro --lite --lite-user-data)'
		)
		.option('--json', 'Output JSON (Lite controls always return JSON)');
	const profile = lite
		.command('profile')
		.description('Read and manage local Lite connection profiles through the running client');

	async function run(
		action: LiteControlAction,
		command: Command,
		payload?: () => unknown | Promise<unknown>
	): Promise<void> {
		const options = command.optsWithGlobals();
		try {
			if (
				(action === 'remove' || action === 'trust' || action === 'close') &&
				options.yes !== true
			) {
				throw new Error('This destructive Lite action requires --yes.');
			}
			const result = await sendLiteCommand(action, await payload?.(), {
				userData: typeof options.userData === 'string' ? options.userData : undefined,
				confirmed: options.yes === true,
			});
			console.log(JSON.stringify(result, null, 2));
			if (!result.success) process.exitCode = 1;
		} catch (error) {
			console.log(
				JSON.stringify(
					{ success: false, error: error instanceof Error ? error.message : String(error) },
					null,
					2
				)
			);
			process.exitCode = 1;
		}
	}

	profile
		.command('list')
		.description('Read saved Lite profiles and current connection state')
		.option('--json', 'Output JSON')
		.action((_options, command: Command) => run('list', command));
	profile
		.command('read <id>')
		.description('Read one saved profile, including validated host identity')
		.option('--json', 'Output JSON')
		.action((id: string, _options, command: Command) => run('read', command, () => id));
	profile
		.command('save')
		.description(
			'Save a complete profile JSON using native URL, SSH, and identity validation; returns the saved profile'
		)
		.requiredOption(
			'--file <path>',
			'Profile JSON file (same fields as profile read; id, name, transport, url, and ssh for SSH)'
		)
		.option('--json', 'Output JSON')
		.action((_options, command: Command) =>
			run('save', command, async () =>
				JSON.parse(await readFile(resolveCliPath(command.opts().file), 'utf8'))
			)
		);
	profile
		.command('remove <id>')
		.description('Remove local connection preferences only; never stops host work')
		.option('--yes', 'Explicitly confirm profile deletion without a native dialog')
		.option('--json', 'Output JSON')
		.action((id: string, _options, command: Command) => run('remove', command, () => id));
	profile
		.command('reset-identity <id>')
		.description(
			'Disconnect and forget the validated host identity; verify the host out of band before connecting again'
		)
		.option('--yes', 'Explicitly confirm identity reset without a native dialog')
		.option('--json', 'Output JSON')
		.action((id: string, _options, command: Command) => run('trust', command, () => id));
	lite
		.command('connect <id>')
		.description(
			'Connect to a saved profile using the native TLS, SSH, authentication, and identity checks'
		)
		.option('--json', 'Output JSON')
		.action((id: string, _options, command: Command) => run('connect', command, () => id));
	const controls: [LiteControlAction, string][] = [
		['status', 'Read connection status, errors, selected profile, and local presentation state'],
		['reconnect', 'Reconnect the selected profile without replaying host commands'],
		[
			'disconnect',
			'Disconnect this client and stop only its owned SSH tunnel; host work continues',
		],
		['connections', 'Show the native connection picker'],
		['commands', 'Show the native connection command palette'],
		['dismiss', 'Return to the remote view or stay on setup; never close Lite'],
		['close', 'Close Maestro Lite only; host work continues'],
	];
	for (const [action, description] of controls) {
		const command = lite.command(action).description(description).option('--json', 'Output JSON');
		if (action === 'close' || action === 'dismiss')
			command.option(
				'--yes',
				action === 'close'
					? 'Explicitly confirm closing this client without a native dialog'
					: 'Accepted for compatibility; dismiss never closes Lite'
			);
		command.action((_options, command: Command) => run(action, command));
	}
}
