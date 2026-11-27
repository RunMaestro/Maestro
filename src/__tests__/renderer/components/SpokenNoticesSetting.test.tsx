/**
 * Tests for SpokenNoticesSetting, "Speak when an agent finishes" in
 * Settings > Notifications.
 *
 * What these guard: the setting is off until the user picks a mode, the Test
 * button reports a line that was not spoken with the app's own reason, and the
 * panel says what a notice will SAY, which depends on a second place (the
 * Spoken notices task in Local Models) the user may never have opened.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { SpokenNoticesSetting } from '../../../renderer/components/SpokenNoticesSetting';
import { THEMES } from '../../../renderer/constants/themes';
import { SPOKEN_NOTICE_TEST_LINE } from '../../../renderer/services/spokenNotices';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';

const theme = THEMES['dracula'];
const taskReadiness = vi.mocked(window.maestro.localModels.taskReadiness);
const speak = vi.mocked(window.maestro.localModels.spokenNotices.speak);

const BASE = { taskId: 'spoken-notices', label: 'Spoken notices', needs: 'text-gen' };
const OFF = {
	...BASE,
	assignment: { type: 'off' },
	state: 'off',
	detail: 'Spoken notices is off.',
};
const READY = {
	...BASE,
	assignment: { type: 'local', modelId: 'qwen3-1.7b-q4' },
	state: 'ready',
	detail: 'Runs Qwen3 on this machine.',
};
const UNAVAILABLE = {
	...BASE,
	assignment: { type: 'local', modelId: 'qwen3-1.7b-q4' },
	state: 'unavailable',
	reason: 'model-not-installed',
	detail: 'Qwen3 1.7B is not downloaded.',
	suggestedAction: 'Download it in Settings > Local Models.',
};

beforeEach(() => {
	taskReadiness.mockReset();
	taskReadiness.mockResolvedValue([]);
	speak.mockReset();
	speak.mockResolvedValue({ spoken: true, text: SPOKEN_NOTICE_TEST_LINE, lineSource: 'given' });
	vi.mocked(window.maestro.settings.set).mockClear();
	useSettingsStore.setState({ spokenNotices: 'off' });
});

describe('SpokenNoticesSetting', () => {
	it('is registered for Settings search', () => {
		const { container } = render(<SpokenNoticesSetting theme={theme} />);
		expect(container.querySelector('[data-setting-id="notifications-spoken"]')).not.toBeNull();
	});

	it('offers the three modes and stores the one picked', () => {
		render(<SpokenNoticesSetting theme={theme} />);

		const modeArea = screen.getByRole('button', { name: 'Off' }).parentElement!.parentElement!;
		expect(modeArea).toHaveClass('flex-1', 'min-w-0');
		expect(modeArea.nextElementSibling).toBe(screen.getByTestId('spoken-notices-test'));
		expect(modeArea.parentElement).toHaveClass('flex', 'gap-2');
		expect(modeArea.parentElement).not.toHaveClass('flex-wrap', 'items-center');

		fireEvent.click(screen.getByRole('button', { name: 'When Maestro is not focused' }));
		expect(useSettingsStore.getState().spokenNotices).toBe('unfocused');
		expect(window.maestro.settings.set).toHaveBeenCalledWith('spokenNotices', 'unfocused');

		fireEvent.click(screen.getByRole('button', { name: 'Always' }));
		expect(useSettingsStore.getState().spokenNotices).toBe('always');

		fireEvent.click(screen.getByRole('button', { name: 'Off' }));
		expect(useSettingsStore.getState().spokenNotices).toBe('off');
	});

	it('speaks a sample line from the Test button, whatever the mode', async () => {
		render(<SpokenNoticesSetting theme={theme} />);

		fireEvent.click(screen.getByTestId('spoken-notices-test'));

		await waitFor(() => expect(speak).toHaveBeenCalledWith(SPOKEN_NOTICE_TEST_LINE));
		await waitFor(() => expect(screen.getByTestId('spoken-notices-test')).not.toBeDisabled());
		expect(screen.queryByTestId('spoken-notices-test-error')).toBeNull();
	});

	it("shows the app's own reason when the sample line was not spoken", async () => {
		speak.mockResolvedValue({
			spoken: false,
			code: 'voice-session-active',
			message: 'A voice session is live, so the notice was not spoken.',
		});
		render(<SpokenNoticesSetting theme={theme} />);

		fireEvent.click(screen.getByTestId('spoken-notices-test'));

		expect(await screen.findByTestId('spoken-notices-test-error')).toHaveTextContent(
			'A voice session is live, so the notice was not spoken.'
		);
	});

	it('asks only the spoken-notices task for readiness', () => {
		render(<SpokenNoticesSetting theme={theme} />);
		expect(taskReadiness).toHaveBeenCalledWith('spoken-notices');
	});

	it('says nothing about the line while notices are off', async () => {
		taskReadiness.mockResolvedValue([OFF] as never);
		render(<SpokenNoticesSetting theme={theme} />);
		await waitFor(() => expect(taskReadiness).toHaveBeenCalled());

		expect(screen.queryByTestId('spoken-notices-plain')).toBeNull();
		expect(screen.queryByTestId('spoken-notices-ready')).toBeNull();
	});

	it('names the plain line, and where to add a summary, while the task is off', async () => {
		taskReadiness.mockResolvedValue([OFF] as never);
		useSettingsStore.setState({ spokenNotices: 'always' });
		render(<SpokenNoticesSetting theme={theme} />);

		const note = await screen.findByTestId('spoken-notices-plain');
		expect(note).toHaveTextContent('"<agent name> finished"');
		expect(note).toHaveTextContent('Settings > Models > System Two');
	});

	it('names the model that writes the summary when the task is ready', async () => {
		taskReadiness.mockResolvedValue([READY] as never);
		useSettingsStore.setState({ spokenNotices: 'unfocused' });
		render(<SpokenNoticesSetting theme={theme} />);

		expect(await screen.findByTestId('spoken-notices-ready')).toHaveTextContent(
			/summary written by/
		);
	});

	it('says why there is no summary, and what is spoken until then, when the model cannot run', async () => {
		taskReadiness.mockResolvedValue([UNAVAILABLE] as never);
		useSettingsStore.setState({ spokenNotices: 'always' });
		render(<SpokenNoticesSetting theme={theme} />);

		const note = await screen.findByTestId('spoken-notices-not-ready');
		expect(note).toHaveTextContent('Qwen3 1.7B is not downloaded.');
		expect(note).toHaveTextContent('Download it in Settings > Local Models.');
		expect(note).toHaveTextContent('Until then the line is "<agent name> finished".');
	});
});
