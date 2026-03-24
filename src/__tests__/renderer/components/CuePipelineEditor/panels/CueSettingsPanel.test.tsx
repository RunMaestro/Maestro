import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CueSettingsPanel } from '../../../../../renderer/components/CuePipelineEditor/panels/CueSettingsPanel';
import { THEMES } from '../../../../../renderer/constants/themes';
import type { CueSettings } from '../../../../../main/cue/cue-types';

vi.mock('../../../../../renderer/hooks/ui', async () => {
	const actual = await vi.importActual<typeof import('../../../../../renderer/hooks/ui')>(
		'../../../../../renderer/hooks/ui'
	);
	return {
		...actual,
		useClickOutside: vi.fn(),
	};
});

const darkTheme = THEMES['dracula'];
const lightTheme = THEMES['github-light'];

const defaultSettings: CueSettings = {
	timeout_minutes: 30,
	timeout_on_fail: 'break',
	max_concurrent: 1,
	queue_size: 10,
};

describe('CueSettingsPanel', () => {
	let onChange: ReturnType<typeof vi.fn>;
	let onClose: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		onChange = vi.fn();
		onClose = vi.fn();
	});

	it('renders with theme background color', () => {
		const { container } = render(
			<CueSettingsPanel
				settings={defaultSettings}
				onChange={onChange}
				onClose={onClose}
				theme={lightTheme}
			/>
		);
		const panel = container.firstElementChild as HTMLElement;
		expect(panel).toHaveStyle({ backgroundColor: lightTheme.colors.bgSidebar });
	});

	it('renders title with theme textMain color', () => {
		render(
			<CueSettingsPanel
				settings={defaultSettings}
				onChange={onChange}
				onClose={onClose}
				theme={darkTheme}
			/>
		);
		const title = screen.getByText('Cue Settings');
		expect(title).toHaveStyle({ color: darkTheme.colors.textMain });
	});

	it('calls onClose when Escape is pressed', () => {
		render(
			<CueSettingsPanel
				settings={defaultSettings}
				onChange={onChange}
				onClose={onClose}
				theme={darkTheme}
			/>
		);
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('renders input fields with theme colors', () => {
		render(
			<CueSettingsPanel
				settings={defaultSettings}
				onChange={onChange}
				onClose={onClose}
				theme={lightTheme}
			/>
		);
		const inputs = screen.getAllByRole('spinbutton');
		expect(inputs.length).toBeGreaterThan(0);
		const firstInput = inputs[0] as HTMLInputElement;
		expect(firstInput).toHaveStyle({ backgroundColor: lightTheme.colors.bgActivity });
	});
});
