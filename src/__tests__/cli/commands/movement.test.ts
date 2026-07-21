import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();

vi.mock('fs', () => ({
	mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
	readFileSync: vi.fn(),
	writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
}));

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));

import { movementBegin, movementInspect, movementProgress } from '../../../cli/commands/movement';
import { withMaestroClient } from '../../../cli/services/maestro-client';

function mockInspection(result: Record<string, unknown>): void {
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({ sendCommand: vi.fn().mockResolvedValue(result) } as never)
	);
}

describe('movement inspect command', () => {
	let consoleLogSpy: MockInstance;
	let consoleErrorSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('prints a JSON error when output is missing', async () => {
		await expect(movementInspect('mockup', { json: true })).rejects.toThrow('__exit__');

		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: 'movement inspect requires --output <png>',
		});
		expect(consoleErrorSpy).not.toHaveBeenCalled();
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('prints one JSON error when the live frame is unavailable', async () => {
		mockInspection({ success: false, error: 'HTML Movement is not visible' });

		await expect(movementInspect('mockup', { output: 'mockup.png', json: true })).rejects.toThrow(
			'__exit__'
		);

		expect(consoleLogSpy).toHaveBeenCalledTimes(1);
		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: 'HTML Movement is not visible',
		});
		expect(consoleErrorSpy).not.toHaveBeenCalled();
	});

	it('prints a JSON error for an invalid screenshot', async () => {
		mockInspection({
			success: true,
			inspection: {
				imageDataUrl: 'not-a-data-url',
				ready: true,
				viewport: { width: 800, height: 600 },
				image: { width: 800, height: 600, scaleFactor: 1 },
				logs: [],
			},
		});

		await expect(movementInspect('mockup', { output: 'mockup.png', json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: 'Maestro returned an invalid designer screenshot',
		});
	});

	it('prints a JSON error for malformed screenshot base64', async () => {
		mockInspection({
			success: true,
			inspection: {
				imageDataUrl: 'data:image/png;base64,%%%%',
				ready: true,
				viewport: { width: 800, height: 600 },
				image: { width: 800, height: 600, scaleFactor: 1 },
				logs: [],
			},
		});

		await expect(movementInspect('mockup', { output: 'mockup.png', json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: 'Maestro returned an invalid designer screenshot',
		});
		expect(mockWriteFileSync).not.toHaveBeenCalled();
	});

	it('prints a JSON error for non-PNG screenshot data', async () => {
		mockInspection({
			success: true,
			inspection: {
				imageDataUrl: `data:image/png;base64,${Buffer.from('not a PNG').toString('base64')}`,
				ready: true,
				viewport: { width: 800, height: 600 },
				image: { width: 800, height: 600, scaleFactor: 1 },
				logs: [],
			},
		});

		await expect(movementInspect('mockup', { output: 'mockup.png', json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: 'Maestro returned an invalid designer screenshot',
		});
		expect(mockWriteFileSync).not.toHaveBeenCalled();
	});

	it('prints a JSON error when the screenshot cannot be written', async () => {
		mockWriteFileSync.mockImplementation(() => {
			throw new Error('disk full');
		});
		mockInspection({
			success: true,
			inspection: {
				imageDataUrl: `data:image/png;base64,${Buffer.from([
					0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
				]).toString('base64')}`,
				ready: true,
				viewport: { width: 800, height: 600 },
				image: { width: 800, height: 600, scaleFactor: 1 },
				logs: [],
			},
		});

		await expect(movementInspect('mockup', { output: 'mockup.png', json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: 'disk full',
		});
	});

	it('prints a JSON error when Maestro cannot be reached', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro is not running'));

		await expect(movementInspect('mockup', { output: 'mockup.png', json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: 'Maestro is not running',
		});
	});
});

describe('movement begin command', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('reserves an HTML shell without authored content', async () => {
		const sendCommand = vi.fn().mockResolvedValue({ success: true });
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);

		await movementBegin('startup', {
			title: 'Loopline startup',
			x: '24',
			y: '36',
			width: '760',
			height: '520',
		});

		expect(sendCommand).toHaveBeenCalledWith(
			{
				type: 'movement',
				op: 'begin',
				id: 'startup',
				viewType: 'html',
				title: 'Loopline startup',
				x: 24,
				y: 36,
				width: 760,
				height: 520,
			},
			'movement_result'
		);
	});

	it('requires a title', async () => {
		await expect(movementBegin('startup', { title: '   ', json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('prints a JSON error for a non-numeric position', async () => {
		await expect(
			movementBegin('startup', { title: 'Loopline startup', x: 'left', json: true })
		).rejects.toThrow('__exit__');

		expect(console.log).toHaveBeenCalledWith(
			JSON.stringify({ success: false, error: '--x must be a number' })
		);
		expect(withMaestroClient).not.toHaveBeenCalled();
	});
});

describe('movement progress command', () => {
	let consoleLogSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('reports a phase without creating a Movement window', async () => {
		const sendCommand = vi.fn().mockResolvedValue({ success: true });
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);

		await movementProgress('startup', {
			title: 'Loopline startup',
			phase: 'composing',
			json: true,
		});

		expect(sendCommand).toHaveBeenCalledWith(
			{
				type: 'movement',
				op: 'progress',
				id: 'startup',
				title: 'Loopline startup',
				phase: 'composing',
				step: 1,
				steps: 1,
			},
			'movement_result'
		);
		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: true,
			id: 'startup',
			op: 'progress',
		});
	});

	it('reports progress within a subdivided phase', async () => {
		const sendCommand = vi.fn().mockResolvedValue({ success: true });
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);

		await movementProgress('startup', {
			title: 'Loopline startup',
			phase: 'refining',
			step: '3',
			steps: '6',
			notes: 'sixteenth,sixteenth+dotted,sixteenth+triad,sixteenth+tie,eighth,eighth',
		});

		expect(sendCommand).toHaveBeenCalledWith(
			{
				type: 'movement',
				op: 'progress',
				id: 'startup',
				title: 'Loopline startup',
				phase: 'refining',
				step: 3,
				steps: 6,
				notes: [
					{ value: 'sixteenth' },
					{ value: 'sixteenth', dotted: true },
					{ value: 'sixteenth', triad: true },
					{ value: 'sixteenth', tie: true },
					{ value: 'eighth' },
					{ value: 'eighth' },
				],
			},
			'movement_result'
		);
		expect(consoleLogSpy).toHaveBeenCalledWith(
			"Concerto 'Loopline startup' is refining, step 3 of 6"
		);
	});

	it('rejects malformed musical notation', async () => {
		await expect(
			movementProgress('startup', {
				title: 'Loopline startup',
				phase: 'refining',
				notes: 'eighth,eighth+tie',
				json: true,
			})
		).rejects.toThrow('__exit__');

		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: '--notes cannot tie the final note forward',
		});
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('rejects a phase outside the Concerto pipeline', async () => {
		await expect(
			movementProgress('startup', {
				title: 'Loopline startup',
				phase: 'sketching',
				json: true,
			})
		).rejects.toThrow('__exit__');

		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: '--phase must be one of: composing, refining, arranging, reviewing, testing',
		});
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it.each([
		{ step: '0', steps: '4', error: '--step must be an integer from 1 through --steps (4)' },
		{ step: '5', steps: '4', error: '--step must be an integer from 1 through --steps (4)' },
		{ step: '1', steps: '9', error: '--steps must be an integer from 1 through 8' },
		{ step: '1.5', steps: '4', error: '--step must be an integer from 1 through --steps (4)' },
		{ step: '1', steps: 'many', error: '--steps must be a number' },
	])('rejects invalid phase subdivision: $step of $steps', async ({ step, steps, error }) => {
		await expect(
			movementProgress('startup', {
				title: 'Loopline startup',
				phase: 'refining',
				step,
				steps,
				json: true,
			})
		).rejects.toThrow('__exit__');

		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({ success: false, error });
		expect(withMaestroClient).not.toHaveBeenCalled();
	});
});
