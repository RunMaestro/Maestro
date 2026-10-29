import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerMemoryCommandCommands } from '../../../cli/commands/memory-command';
import { sendSimpleCommand } from '../../../cli/services/session-command';
import { readFile, stat } from 'fs/promises';

vi.mock('../../../cli/services/session-command', async (original) => ({
	...(await original<typeof import('../../../cli/services/session-command')>()),
	sendSimpleCommand: vi.fn(),
}));
vi.mock('../../../cli/services/storage', () => ({ readSettingValue: vi.fn() }));
import { readSettingValue } from '../../../cli/services/storage';
import { MaestroNotRunningError } from '../../../cli/services/maestro-not-running';

vi.mock('fs/promises', () => ({ readFile: vi.fn(), stat: vi.fn() }));
const previousExitCode = process.exitCode;
const selection = {
	requestId: 'provisional',
	status: 'selected',
	dirty: false,
	textSnapshot: 'synthetic source',
	sourceRef: {
		sourceAgentId: 'source',
		provider: 'codex',
		location: { kind: 'local' },
		codexHome: '/fixture',
		memoryRoot: '/fixture/memories',
		relativePath: 'memory.md',
	},
	generator: { agentId: 'generator', provider: 'codex', model: '', effort: '' },
};
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(readSettingValue).mockReturnValue({ plugins: true });
	log = vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.mocked(stat).mockResolvedValue({ size: 200 } as any);
	vi.mocked(readFile).mockResolvedValue(JSON.stringify(selection));
	vi.mocked(sendSimpleCommand).mockResolvedValue({
		success: true,
		requestId: 'transport',
		draftRequestId: 'draft-id',
		status: 'selected',
	});
});
afterEach(() => {
	process.exitCode = previousExitCode;
	vi.restoreAllMocks();
});
async function run(args: string[]) {
	const program = new Command().exitOverride();
	registerMemoryCommandCommands(program);
	await program.parseAsync(['memory-command', ...args], { from: 'user' });
	return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
}

describe('registered memory-command CLI verbs', () => {
	it('selects an explicit bounded file with a shared DTO before transport, without starting a provider', async () => {
		expect(
			await run(['select', '--file', './selection.json', '--viewer', 'work', '--json'])
		).toEqual({ success: true, draftRequestId: 'draft-id', status: 'selected' });
		expect(sendSimpleCommand).toHaveBeenCalledExactlyOnceWith(
			{ type: 'memory_command', action: 'select', viewerId: 'work', selection },
			'memory_command_result'
		);
	});
	it.each(['generate', 'status', 'cancel', 'preview'])(
		'routes %s with the same owner and draft ID',
		async (action) => {
			await run([action, 'request-id', '--viewer', 'work', '--json']);
			expect(sendSimpleCommand).toHaveBeenCalledExactlyOnceWith(
				{
					type: 'memory_command',
					action,
					viewerId: 'work',
					draftRequestId: 'request-id',
					...(action === 'preview' ? { background: true } : {}),
				},
				'memory_command_result'
			);
		}
	);
	it.each([
		['--background', true],
		['--focus', false],
	] as const)('passes explicit preview placement %s', async (flag, background) => {
		await run(['preview', 'request-id', flag]);
		expect(sendSimpleCommand).toHaveBeenCalledWith(
			expect.objectContaining({ background }),
			'memory_command_result'
		);
	});
	it('saves edited fields through the registered verb and requires a confirmed saved result', async () => {
		const draft = { command: 'edited', description: 'Edited', prompt: 'Edited prompt' };
		vi.mocked(readFile).mockResolvedValue(JSON.stringify(draft));
		vi.mocked(sendSimpleCommand).mockResolvedValue({
			success: true,
			status: 'saved',
			draftRequestId: 'draft-id',
		});
		expect(
			await run(['save', 'draft-id', '--file', './edited.json', '--viewer', 'work'])
		).toMatchObject({ success: true, status: 'saved' });
		expect(sendSimpleCommand).toHaveBeenCalledExactlyOnceWith(
			{
				type: 'memory_command',
				action: 'save',
				viewerId: 'work',
				draftRequestId: 'draft-id',
				draft,
			},
			'memory_command_result'
		);
		expect(process.exitCode).toBe(previousExitCode);
	});
	it.each(['collision', 'retry'])(
		'returns %s with a failing exit code, preserving the retry result',
		async (status) => {
			vi.mocked(readFile).mockResolvedValue(
				JSON.stringify({ command: 'edited', description: 'Edited', prompt: 'Edited prompt' })
			);
			vi.mocked(sendSimpleCommand).mockResolvedValue({ success: false, status });
			expect(await run(['save', 'draft-id', '--file', 'draft.json'])).toEqual({
				success: false,
				status,
			});
			expect(process.exitCode).toBe(1);
		}
	);
	it.each(['invalid', 'extra', 'oversized'])(
		'rejects %s edited fields before transport',
		async (kind) => {
			vi.mocked(readFile).mockResolvedValue(
				JSON.stringify({
					command: 'edited',
					description: 'Edited',
					prompt:
						kind === 'oversized' ? 'é'.repeat(65537) : kind === 'invalid' ? '' : 'Edited prompt',
					...(kind === 'extra' ? { scope: 'project' } : {}),
				})
			);
			expect((await run(['save', 'draft-id', '--file', 'edited.json'])).success).toBe(false);
			expect(sendSimpleCommand).not.toHaveBeenCalled();
		}
	);
	it.each([
		[[], true],
		[['--background'], true],
		[['--focus'], false],
	] as const)(
		'routes the optional editable preview with placement %j',
		async (flags, background) => {
			await run(['preview', 'draft-id', '--editor', ...flags]);
			expect(sendSimpleCommand).toHaveBeenCalledExactlyOnceWith(
				{
					type: 'memory_command',
					action: 'preview',
					viewerId: 'cli',
					draftRequestId: 'draft-id',
					editor: true,
					background,
				},
				'memory_command_result'
			);
			expect(readFile).not.toHaveBeenCalled();
		}
	);
	it.each(['malformed', 'oversized', 'schema'])(
		'rejects %s input without leaking it or calling the host',
		async (kind) => {
			if (kind === 'malformed') vi.mocked(readFile).mockResolvedValue('{PRIVATE');
			if (kind === 'oversized') vi.mocked(stat).mockResolvedValue({ size: 2 ** 21 } as any);
			if (kind === 'schema')
				vi.mocked(readFile).mockResolvedValue(
					JSON.stringify({ ...selection, textSnapshot: 'é'.repeat(65537) })
				);
			expect(await run(['select', '--file', 'selection.json'])).toEqual({
				success: false,
				error: 'MemoryCommandUnavailable',
			});
			expect(sendSimpleCommand).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(1);
		}
	);
	it('reports failed host operations with a nonzero exit code', async () => {
		vi.mocked(sendSimpleCommand).mockResolvedValue({
			success: false,
			error: 'MemoryCommandUnavailable',
		});
		expect((await run(['status', 'request-id'])).success).toBe(false);
		expect(process.exitCode).toBe(1);
	});
});

it('preserves the stopped desktop JSON code and exit status', async () => {
	vi.mocked(sendSimpleCommand).mockRejectedValueOnce(
		new MaestroNotRunningError('no-discovery-file')
	);
	const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('exit');
	});
	await expect(run(['status', 'request-id', '--json'])).rejects.toThrow('exit');
	expect(exit).toHaveBeenCalledWith(3);
	expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
		success: false,
		code: 'MAESTRO_NOT_RUNNING',
	});
});
it('hides and refuses memory commands while Plugins is off', async () => {
	vi.mocked(readSettingValue).mockReturnValue({ plugins: false });
	const program = new Command().exitOverride();
	registerMemoryCommandCommands(program);
	expect(program.helpInformation()).not.toContain('memory-command');
	const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('exit');
	});
	await expect(
		program.parseAsync(['memory-command', 'generate', 'request', '--json'], { from: 'user' })
	).rejects.toThrow('exit');
	expect(exit).toHaveBeenCalledWith(1);
	expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
		code: 'PLUGINS_DISABLED',
	});
	expect(sendSimpleCommand).not.toHaveBeenCalled();
});
