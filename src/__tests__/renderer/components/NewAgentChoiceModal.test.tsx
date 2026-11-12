/**
 * Tests for NewAgentChoiceModal.
 *
 * Two tiles side by side at 390px wrapped their copy into columns a few words
 * wide; on a phone they stack. Both tiles keep firing their handlers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NewAgentChoiceModal } from '../../../renderer/components/NewAgentChoiceModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { usePhoneLayout } from '../../../renderer/hooks/ui/useViewportBreakpoint';
import { mockTheme } from '../../helpers/mockTheme';

vi.mock('../../../renderer/hooks/ui/useViewportBreakpoint', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/hooks/ui/useViewportBreakpoint')>()),
	usePhoneLayout: vi.fn(() => false),
}));
const mockedUsePhoneLayout = vi.mocked(usePhoneLayout);

function renderModal(overrides: Partial<React.ComponentProps<typeof NewAgentChoiceModal>> = {}) {
	const props = {
		theme: mockTheme,
		onClose: vi.fn(),
		onManualSetup: vi.fn(),
		onWizardSetup: vi.fn(),
		wizardAvailable: true,
		...overrides,
	};
	render(
		<LayerStackProvider>
			<NewAgentChoiceModal {...props} />
		</LayerStackProvider>
	);
	return props;
}

afterEach(() => {
	mockedUsePhoneLayout.mockReturnValue(false);
});

describe('NewAgentChoiceModal', () => {
	it('lays the two tiles out side by side on desktop', () => {
		renderModal();
		const grid = screen.getByTestId('manual-setup-tile').parentElement as HTMLElement;
		expect(grid).toHaveClass('grid-cols-2');
		expect(grid).not.toHaveClass('grid-cols-1');
	});

	it('stacks the tiles on a phone', () => {
		mockedUsePhoneLayout.mockReturnValue(true);
		renderModal();
		const grid = screen.getByTestId('manual-setup-tile').parentElement as HTMLElement;
		expect(grid).toHaveClass('grid-cols-1');
		expect(grid).not.toHaveClass('grid-cols-2');
	});

	it('closes and fires the chosen setup path', () => {
		const props = renderModal();
		fireEvent.click(screen.getByTestId('manual-setup-tile'));
		expect(props.onClose).toHaveBeenCalledTimes(1);
		expect(props.onManualSetup).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByTestId('wizard-setup-tile'));
		expect(props.onWizardSetup).toHaveBeenCalledTimes(1);
	});

	it('disables the wizard tile when the wizard is unavailable', () => {
		const props = renderModal({ wizardAvailable: false });
		const tile = screen.getByTestId('wizard-setup-tile');
		expect(tile).toBeDisabled();
		fireEvent.click(tile);
		expect(props.onWizardSetup).not.toHaveBeenCalled();
	});
});
