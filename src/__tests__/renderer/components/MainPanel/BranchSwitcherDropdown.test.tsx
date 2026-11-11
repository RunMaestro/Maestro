import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BranchSwitcherDropdown } from '../../../../renderer/components/MainPanel/BranchSwitcherDropdown';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { gitService } from '../../../../renderer/services/git';
import { mockTheme } from '../../../helpers/mockTheme';

vi.mock('../../../../renderer/services/git', () => ({
	gitService: {
		getBranches: vi.fn(),
		switchBranch: vi.fn(),
	},
}));

async function setup() {
	const anchor = document.createElement('button');
	document.body.appendChild(anchor);
	render(
		<LayerStackProvider>
			<BranchSwitcherDropdown
				cwd="/repo"
				currentBranch="main"
				theme={mockTheme}
				anchorEl={anchor}
				onClose={vi.fn()}
				onSwitched={vi.fn()}
			/>
		</LayerStackProvider>
	);
	const input = await screen.findByPlaceholderText('Filter branches…');
	await screen.findByText('feature/ime');
	fireEvent.change(input, { target: { value: 'feature' } });
	return input;
}

describe('BranchSwitcherDropdown filter Enter', () => {
	beforeEach(() => {
		vi.mocked(gitService.getBranches).mockResolvedValue(['main', 'feature/ime']);
		vi.mocked(gitService.switchBranch).mockResolvedValue({ success: true } as never);
	});

	it('leaves Enter to the input method during an IME composition', async () => {
		const input = await setup();

		for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
			expect(fireEvent.keyDown(input, { key: 'Enter', ...ime })).toBe(true);
		}

		expect(gitService.switchBranch).not.toHaveBeenCalled();
	});

	it('switches to the highlighted branch on a normal Enter', async () => {
		const input = await setup();

		expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);

		await waitFor(() => {
			expect(gitService.switchBranch).toHaveBeenCalledWith('/repo', 'feature/ime', undefined);
		});
	});
});
