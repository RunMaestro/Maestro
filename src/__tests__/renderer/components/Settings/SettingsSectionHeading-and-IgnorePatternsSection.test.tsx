import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { Type } from 'lucide-react';
import { SettingsSectionHeading } from '../../../../renderer/components/Settings/SettingsSectionHeading';
import { vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { IgnorePatternsSection } from '../../../../renderer/components/Settings/IgnorePatternsSection';
import { mockTheme } from '../../../helpers/mockTheme';
import { beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { HostMediaSection } from '../../../../renderer/components/Settings/HostMediaSection';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { THEMES } from '../../../../shared/themes';
__maestroMicrobenchDescribe('SettingsSectionHeading', () => {
	describe('SettingsSectionHeading', () => {
		it('renders the label on the description dim scale with its icon', () => {
			const { container } = render(
				<SettingsSectionHeading icon={Type}>Fonts</SettingsSectionHeading>
			);

			const label = screen.getByText('Fonts');
			expect(label.className).toContain('opacity-70');
			expect(label.className).toContain('uppercase');
			expect(label.className).toContain('font-bold');
			// `block` and `flex` on one element contradict each other; the layout the
			// icon needs is the flex row, so that is the one that stays.
			expect(label.className).toContain('flex');
			expect(label.className).not.toContain('block');
			expect(container.querySelector('svg')).toBeInTheDocument();
		});

		it('reserves the heading-to-card gap when there is no description', () => {
			render(<SettingsSectionHeading icon={Type}>Fonts</SettingsSectionHeading>);

			expect(screen.getByText('Fonts').className).toContain('mb-2');
		});

		it('renders a description on the standard description scale', () => {
			render(
				<SettingsSectionHeading icon={Type} description="Interface is the proportional face.">
					Fonts
				</SettingsSectionHeading>
			);

			const description = screen.getByText('Interface is the proportional face.');
			expect(description.tagName).toBe('P');
			expect(description.className).toContain('text-xs');
			expect(description.className).toContain('opacity-70');
			expect(description.className).toContain('mb-2');
		});

		it('moves the bottom margin below the pair rather than clawing it back', () => {
			// The four sections that hand-rolled this paragraph each cancelled the
			// heading's own `mb-2` with a `-mt-1`. Owning both halves states the gap
			// once: the label tightens to `mb-1` and only the paragraph carries the
			// margin to the card below.
			render(
				<SettingsSectionHeading icon={Type} description="Scales every surface by the same amount.">
					Zoom
				</SettingsSectionHeading>
			);

			const label = screen.getByText('Zoom');
			expect(label.className).toContain('mb-1');
			expect(label.className).not.toContain('mb-2');
			expect(screen.getByText('Scales every surface by the same amount.').className).not.toContain(
				'-mt-'
			);
		});

		it('accepts a node description so state-dependent copy can be passed through', () => {
			render(
				<SettingsSectionHeading
					icon={Type}
					description={
						<>
							Set every font and size above at once. <strong>You are on Default.</strong>
						</>
					}
				>
					Factory Reset Fonts
				</SettingsSectionHeading>
			);

			expect(screen.getByText('You are on Default.')).toBeInTheDocument();
		});
	});
});
__maestroMicrobenchDescribe('IgnorePatternsSection', () => {
	function setup() {
		const onIgnorePatternsChange = vi.fn();
		render(
			<IgnorePatternsSection
				theme={mockTheme}
				title="Local Ignore Patterns"
				description="Patterns to skip"
				ignorePatterns={['node_modules']}
				onIgnorePatternsChange={onIgnorePatternsChange}
				defaultPatterns={['node_modules']}
			/>
		);
		const input = screen.getByPlaceholderText(/Enter glob pattern/);
		fireEvent.change(input, { target: { value: '*.log' } });
		return { input, onIgnorePatternsChange };
	}

	describe('IgnorePatternsSection Enter', () => {
		it('adds the pattern on Enter', () => {
			const { input, onIgnorePatternsChange } = setup();

			expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);

			expect(onIgnorePatternsChange).toHaveBeenCalledWith(['node_modules', '*.log']);
		});

		it('leaves Enter to the input method during an IME composition', () => {
			const { input, onIgnorePatternsChange } = setup();

			for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
				expect(fireEvent.keyDown(input, { key: 'Enter', ...ime })).toBe(true);
			}

			expect(onIgnorePatternsChange).not.toHaveBeenCalled();
		});
	});
});
__maestroMicrobenchDescribe('HostMediaSection', () => {
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
				expect(
					await screen.findByText('Missing prerequisites: model-directory')
				).toBeInTheDocument();
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
});
