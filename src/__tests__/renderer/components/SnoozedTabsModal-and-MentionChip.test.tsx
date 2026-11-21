import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { SnoozedTabsModal } from '../../../renderer/components/SnoozedTabsModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../helpers/mockTheme';
import { getMentionChipColors } from '../../../renderer/components/MentionChip';
import type { Theme } from '../../../renderer/types';
import { AgentsLoadingView } from '../../../renderer/components/AgentsLoadingView';
__maestroMicrobenchDescribe('SnoozedTabsModal', () => {
	function renderList() {
		const onClose = vi.fn();
		render(
			<LayerStackProvider>
				<SnoozedTabsModal theme={mockTheme} onClose={onClose} />
			</LayerStackProvider>
		);
		return { onClose };
	}

	describe('SnoozedTabsModal history layering', () => {
		it('returns to the snoozed tabs list when Escape closes the history', async () => {
			const { onClose } = renderList();

			fireEvent.click(screen.getByText('View History'));
			expect(await screen.findByText('Snooze History')).toBeInTheDocument();

			fireEvent.keyDown(window, { key: 'Escape' });

			await waitFor(() => {
				expect(screen.queryByText('Snooze History')).not.toBeInTheDocument();
			});
			expect(screen.getByText('Snoozed Tabs')).toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();
		});

		it('closes the list itself on a second Escape', async () => {
			const { onClose } = renderList();

			fireEvent.click(screen.getByText('View History'));
			expect(await screen.findByText('Snooze History')).toBeInTheDocument();

			fireEvent.keyDown(window, { key: 'Escape' });
			await waitFor(() => {
				expect(screen.queryByText('Snooze History')).not.toBeInTheDocument();
			});

			fireEvent.keyDown(window, { key: 'Escape' });
			await waitFor(() => {
				expect(onClose).toHaveBeenCalledTimes(1);
			});
		});
	});
});
__maestroMicrobenchDescribe('MentionChip', () => {
	function makeTheme(overrides: Partial<Theme['colors']> = {}): Theme {
		return {
			id: 'dracula',
			name: 'Test',
			mode: 'dark',
			colors: {
				bgMain: '#111111',
				bgSidebar: '#0a0a0a',
				bgActivity: '#161616',
				border: '#333333',
				textMain: '#eeeeee',
				textDim: '#888888',
				accent: '#7c3aed',
				accentDim: '#5b21b6',
				accentText: '#c4b5fd',
				accentForeground: '#ffffff',
				success: '#22c55e',
				warning: '#eab308',
				error: '#ef4444',
				...overrides,
			},
		} as Theme;
	}

	describe('getMentionChipColors', () => {
		it('derives subtle tints from accent/border/text when tokens are unset', () => {
			const colors = getMentionChipColors(makeTheme());
			expect(colors.bg).toContain('color-mix');
			expect(colors.bg).toContain('#7c3aed'); // accent
			expect(colors.border).toContain('color-mix');
			expect(colors.text).toBe('#eeeeee'); // falls back to textMain
		});

		it('prefers explicit theme tokens when a theme sets them', () => {
			const colors = getMentionChipColors(
				makeTheme({
					mentionChipBg: '#202020',
					mentionChipBorder: '#404040',
					mentionChipText: '#dddddd',
				})
			);
			expect(colors).toEqual({ bg: '#202020', border: '#404040', text: '#dddddd' });
		});
	});
});
__maestroMicrobenchDescribe('AgentsLoadingView', () => {
	describe('AgentsLoadingView', () => {
		it('renders the MAESTRO branding and a loading message', () => {
			render(<AgentsLoadingView theme={mockTheme} />);
			expect(screen.getByText('MAESTRO')).toBeInTheDocument();
			expect(screen.getByText('Loading your agents...')).toBeInTheDocument();
		});

		it('renders an accessible spinner so the load state is announced', () => {
			render(<AgentsLoadingView theme={mockTheme} />);
			// Spinner renders Loader2 with role="status" and the aria-label below.
			expect(screen.getByLabelText('Loading agents')).toBeInTheDocument();
		});
	});
});
