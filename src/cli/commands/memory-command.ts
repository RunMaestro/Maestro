import { encoreCommand, readEncoreFlagsForHelp } from '../utils/encore-gate';
import type { Command } from 'commander';
import { readFile, stat } from 'fs/promises';
import { sendSimpleCommand, exitIfMaestroNotRunning } from '../services/session-command';
import { resolveCliPath } from '../utils/parse';
import {
	validateMemoryCommandSelection,
	isMemoryCommandDraft,
	MEMORY_COMMAND_MAX_BYTES,
} from '../../shared/memoryCommandDraft';
import { resolveBackgroundFlag } from '../../shared/focusPlacement';

/** Every verb uses the authenticated desktop workflow; no source/settings writes or local runner. */
export function registerMemoryCommandCommands(program: Command): void {
	const memory = encoreCommand(
		program,
		'memory-command',
		'plugins',
		readEncoreFlagsForHelp()
	).description(
		'Draft, preview and explicitly save a global command from Codex memory (JSON output)'
	);
	const run = async (action: string, command: Command, draftRequestId?: string) => {
		try {
			const options = command.opts();
			let fileValue: unknown;
			if (action === 'select' || action === 'save') {
				const file = resolveCliPath(options.file);
				// Bound the JSON envelope too; validation separately bounds the UTF-8 snapshot.
				if ((await stat(file)).size > MEMORY_COMMAND_MAX_BYTES * 8)
					throw new Error('MemoryCommandInvalid');
				const text = await readFile(file, 'utf8');
				if (Buffer.byteLength(text) > MEMORY_COMMAND_MAX_BYTES * 8)
					throw new Error('MemoryCommandInvalid');
				fileValue = JSON.parse(text);
				if (action === 'select') validateMemoryCommandSelection(fileValue);
				else if (!isMemoryCommandDraft(fileValue)) throw new Error('MemoryCommandInvalid');
			}
			const result = await sendSimpleCommand(
				{
					type: 'memory_command',
					action,
					viewerId: options.viewer,
					...(action === 'select' ? { selection: fileValue } : { draftRequestId }),
					...(action === 'save' ? { draft: fileValue } : {}),
					...(action === 'preview'
						? {
								background: resolveBackgroundFlag(options, 'memory-command-preview'),
								...(options.editor ? { editor: true } : {}),
							}
						: {}),
				},
				'memory_command_result'
			);
			// Do not print the transport correlation ID as a draft request ID.
			const { requestId: _correlation, type: _type, ...payload } = result;
			console.log(JSON.stringify(payload, null, 2));
			if (!result.success || (action === 'save' && result.status !== 'saved')) process.exitCode = 1;
		} catch (error) {
			exitIfMaestroNotRunning(error, { json: true });
			// JSON parse/provider/transport errors can echo supplied source text.
			console.log(JSON.stringify({ success: false, error: 'MemoryCommandUnavailable' }));
			process.exitCode = 1;
		}
	};
	memory
		.command('select')
		.description('Register a MemoryCommandSelection JSON file without starting a generator')
		.requiredOption('--file <path>', 'Explicit selection JSON file')
		.option('--viewer <id>', 'Workflow owner namespace (reuse for subsequent verbs)', 'cli')
		.option('--json', 'Output JSON')
		.action((_options, command: Command) => run('select', command));
	for (const action of ['generate', 'status', 'cancel', 'preview'] as const) {
		const verb = memory
			.command(`${action} <request-id>`)
			.description(
				action === 'preview'
					? 'Read the draft as JSON; --editor also delivers an editable preview without saving'
					: ({
							generate: 'Start an owned request asynchronously; poll status for completion',
							status: 'Read an owned request status without source or response text',
							cancel: 'Cancel an owned request and clear its transient text',
						}[action] ?? action)
			)
			.option('--viewer <id>', 'Workflow owner namespace used by select', 'cli')
			.option('--json', 'Output JSON');
		if (action === 'preview')
			verb
				.option('--editor', 'Stage the existing command editor; --focus opens Settings')
				.option('--background', 'Keep the current view (default)')
				.option('--focus', 'Allow foreground placement');
		verb.action((id: string, _options, command: Command) => run(action, command, id));
	}
	memory
		.command('save <request-id>')
		.description(
			'Explicitly save edited command/description/prompt JSON through the owned host request'
		)
		.requiredOption('--file <path>', 'JSON object with exactly command, description and prompt')
		.option('--viewer <id>', 'Workflow owner namespace used by select', 'cli')
		.option('--json', 'Output JSON')
		.action((id: string, _options, command: Command) => run('save', command, id));
}
