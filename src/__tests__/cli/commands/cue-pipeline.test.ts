/**
 * @file cue-pipeline.test.ts
 * @description `cue pipeline` beside a headless host: the host does not serve
 * the desktop Pipeline Graph layout, so every verb says so and names what to
 * do instead, while an old desktop build keeps its own restart hint.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import {
	CUE_PIPELINE_HEADLESS_MESSAGE,
	cuePipelineGet,
	cuePipelineList,
	cuePipelineRemove,
} from '../../../cli/commands/cue-pipeline';
import { UnsupportedCommandError, withMaestroClient } from '../../../cli/services/maestro-client';

describe('cue pipeline beside a headless host', () => {
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it.each([
		['list', () => cuePipelineList({ json: true })],
		['get', () => cuePipelineGet('nightly', { json: true })],
		['remove', () => cuePipelineRemove('nightly', { json: true })],
	])('%s names what a host does not serve and what to do instead', async (_verb, run) => {
		vi.mocked(withMaestroClient).mockRejectedValue(
			new UnsupportedCommandError('cue_pipeline_list', 'headless')
		);

		await expect(run()).rejects.toThrow('__exit__');

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(console.log).toHaveBeenCalledWith(
			JSON.stringify({ type: 'error', error: CUE_PIPELINE_HEADLESS_MESSAGE })
		);
	});

	it('keeps the restart hint for an old desktop build', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(
			new UnsupportedCommandError('cue_pipeline_list')
		);

		await expect(cuePipelineList({})).rejects.toThrow('__exit__');

		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('rebuild and restart'));
		expect(console.error).not.toHaveBeenCalledWith(
			expect.stringContaining('Pipeline Graph layout')
		);
	});
});
