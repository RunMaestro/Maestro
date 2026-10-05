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
	const discovery = lite
		.command('discovery')
		.description('Local-network and consented Tailscale peer or advertised Service discovery');
	discovery.command('show').action((_options, command: Command) => run('discover', command));
	discovery
		.command('status')
		.action((_options, command: Command) => run('discovery-status', command));
	discovery.command('stop').action((_options, command: Command) => run('discovery-stop', command));
	discovery
		.command('start')
		.option(
			'--interface <ipv4>',
			'Advanced override: use one approved LAN interface instead of automatic selection'
		)
		.option('--no-lan', 'Do not browse local-network advertisements')
		.option('--no-tailscale', 'Do not read existing Tailscale client service metadata')
		.option(
			'--tailscale-peers',
			'Allow fixed HTTPS 443 Maestro checks of up to 32 existing peers per refresh; no login or trust'
		)
		.action((options, command: Command) =>
			run('discovery-start', command, () => ({
				interfaceAddress: options.interface,
				lan: options.lan,
				tailscale: options.tailscale,
				tailscalePeers: options.tailscalePeers,
			}))
		);
	discovery
		.command('import')
		.description('Read an expiring host invitation from stdin; never connect or save trust')
		.action((_options, command: Command) =>
			run('discovery-import', command, async () => {
				let invitation = '';
				for await (const chunk of process.stdin) {
					invitation += chunk.toString();
					if (invitation.length > 4096) throw new Error('Invitation is too large');
				}
				return invitation.trim();
			})
		);
	const pairing = lite
		.command('pair')
		.description('Attended metadata-only PIN proof; never creates a full Maestro login');
	pairing
		.command('request <key>')
		.requiredOption('--generation <n>', 'Generation from discovery status')
		.requiredOption('--name <label>', 'Self-asserted client label')
		.action((key: string, options, command: Command) =>
			run('pair-request', command, () => ({
				key,
				generation: Number(options.generation),
				name: options.name,
			}))
		);
	pairing
		.command('submit')
		.requiredOption('--pin-stdin', 'Read six-digit PIN from stdin, not process arguments')
		.action((_options, command: Command) =>
			run('pair-submit', command, async () => {
				let value = '';
				for await (const chunk of process.stdin) {
					value += chunk.toString();
					if (value.length > 16) throw new Error('Expected six-digit PIN');
				}
				const pin = value.trim();
				if (!/^\d{6}$/.test(pin)) throw new Error('Expected six-digit PIN');
				return pin;
			})
		);
	pairing.command('read').action((_options, command: Command) => run('pair-read', command));
	pairing.command('cancel').action((_options, command: Command) => run('pair-cancel', command));
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
