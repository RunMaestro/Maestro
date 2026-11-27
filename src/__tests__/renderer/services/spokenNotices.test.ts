/**
 * Tests for the renderer side of spoken notices: reporting a finished turn to
 * main, and the Test button's sample line.
 *
 * What these guard: a user who never opted in sends nothing across the bridge,
 * an agent's megabyte reply is cut down before it is sent, and a report is
 * fire and forget, so nothing a turn does afterwards can fail because of it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
	SPOKEN_NOTICE_TEST_LINE,
	announceAgentFinished,
	speakTestNotice,
} from '../../../renderer/services/spokenNotices';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';

const agentFinished = vi.mocked(window.maestro.localModels.spokenNotices.agentFinished);
const speak = vi.mocked(window.maestro.localModels.spokenNotices.speak);

const NOTICE = { agentName: 'Backend', prompt: 'Fix the test', response: 'Fixed. Tests pass.' };

beforeEach(() => {
	agentFinished.mockReset();
	agentFinished.mockResolvedValue({
		spoken: true,
		text: 'Backend finished',
		lineSource: 'fallback',
	});
	speak.mockReset();
	speak.mockResolvedValue({ spoken: true, text: SPOKEN_NOTICE_TEST_LINE, lineSource: 'given' });
	useSettingsStore.setState({ spokenNotices: 'always' });
});

describe('announceAgentFinished', () => {
	it('sends nothing while the setting is off', () => {
		useSettingsStore.setState({ spokenNotices: 'off' });

		announceAgentFinished(NOTICE);

		expect(agentFinished).not.toHaveBeenCalled();
	});

	it('reports the turn in either speaking mode, leaving the decision to main', () => {
		announceAgentFinished(NOTICE);
		useSettingsStore.setState({ spokenNotices: 'unfocused' });
		announceAgentFinished(NOTICE);

		expect(agentFinished).toHaveBeenCalledTimes(2);
		expect(agentFinished).toHaveBeenLastCalledWith(NOTICE);
	});

	it('cuts a huge reply down before it crosses the bridge', () => {
		announceAgentFinished({ ...NOTICE, response: `${'x'.repeat(200_000)} THE END` });

		const sent = agentFinished.mock.calls[0][0];
		expect(sent.response!.length).toBeLessThan(3000);
		expect(sent.response!.endsWith('THE END')).toBe(true);
	});

	it('never throws, whatever main answers', async () => {
		agentFinished.mockRejectedValueOnce(new Error('bridge is gone'));
		expect(() => announceAgentFinished(NOTICE)).not.toThrow();

		agentFinished.mockResolvedValueOnce({
			spoken: false,
			code: 'speech-failed',
			message: 'No speech engine.',
		});
		expect(() => announceAgentFinished(NOTICE)).not.toThrow();
		// Let both settle: an unhandled rejection here would fail the run.
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
});

describe('speakTestNotice', () => {
	it('speaks the sample line through the path a real notice takes', async () => {
		await expect(speakTestNotice()).resolves.toMatchObject({ spoken: true });
		expect(speak).toHaveBeenCalledWith(SPOKEN_NOTICE_TEST_LINE);
	});
});
