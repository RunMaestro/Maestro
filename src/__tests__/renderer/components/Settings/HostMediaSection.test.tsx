import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HostMediaSection } from '../../../../renderer/components/Settings/HostMediaSection';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { mockTheme } from '../../../helpers/mockTheme';
import { THEMES } from '../../../../shared/themes';

const getMediaStatus = vi.fn();
const setDirectory = vi.fn();

beforeEach(() => {
	getMediaStatus
		.mockReset()
		.mockResolvedValue({ profiles: [], models: [], missing: ['model-directory'] });
	setDirectory.mockReset().mockResolvedValue(false);
	window.maestro.settings.getMediaStatus = getMediaStatus;
	useSettingsStore.setState({ mediaModelDirectory: '', setMediaModelDirectory: setDirectory });
});

describe('HostMediaSection', () => {
	it.each(['ayu-light', 'solarized-dark'])(
		'shows actual missing prerequisites using %s',
		async (themeId) => {
			render(<HostMediaSection theme={THEMES[themeId]} />);
			expect(await screen.findByText('Missing prerequisites: model-directory')).toBeInTheDocument();
			expect(screen.getByText('Host media status: Unavailable')).toBeInTheDocument();
			expect(screen.getByText(/small requires ggml-small.bin/)).toBeInTheDocument();
		}
	);

	it('reports save failure while keeping the draft and previous status', async () => {
		render(<HostMediaSection theme={mockTheme} />);
		await screen.findByText('Missing prerequisites: model-directory');
		fireEvent.change(screen.getByLabelText('Whisper model directory'), {
			target: { value: '~/models' },
		});
		fireEvent.click(screen.getByText('Save directory'));
		expect(await screen.findByText(/Could not save. Use an absolute path/)).toBeInTheDocument();
		expect(screen.getByLabelText('Whisper model directory')).toHaveValue('~/models');
		expect(getMediaStatus).toHaveBeenCalledTimes(1);
	});

	it('saves the host setting and shows the available base model without assuming small exists', async () => {
		setDirectory.mockImplementation(async () => {
			getMediaStatus.mockResolvedValue({
				profiles: ['whisper-cli'],
				models: ['base'],
				missing: [],
			});
			useSettingsStore.setState({ mediaModelDirectory: '/canonical/models' });
			return true;
		});
		render(<HostMediaSection theme={mockTheme} />);
		await screen.findByText('Missing prerequisites: model-directory');
		fireEvent.change(screen.getByLabelText('Whisper model directory'), {
			target: { value: '/alias/models' },
		});
		fireEvent.click(screen.getByText('Save directory'));
		expect(await screen.findByText('Available models: base')).toBeInTheDocument();
		expect(screen.getByText('Host media status: Ready')).toBeInTheDocument();
		expect(screen.getByLabelText('Whisper model directory')).toHaveValue('/canonical/models');
		expect(setDirectory).toHaveBeenCalledWith('/alias/models');
	});

	it('allows retrying a failed status read', async () => {
		getMediaStatus.mockRejectedValueOnce(new Error('private host diagnostic'));
		render(<HostMediaSection theme={mockTheme} />);
		expect(await screen.findByText(/Could not read host media status/)).toBeInTheDocument();
		expect(screen.queryByText('private host diagnostic')).not.toBeInTheDocument();
		fireEvent.click(screen.getByText('Check status'));
		await waitFor(() =>
			expect(screen.getByText('Missing prerequisites: model-directory')).toBeInTheDocument()
		);
	});
});
