import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuickChatSection } from '../../../../../../renderer/components/Settings/tabs/EncoreTab/components';
import { DEFAULT_QUICK_CHAT_SETTINGS } from '../../../../../../shared/quickChat';
import { mockTheme } from '../../../../../helpers/mockTheme';

function renderSection(persistent = false) {
	render(
		<QuickChatSection
			theme={mockTheme}
			quickChatSettings={{ ...DEFAULT_QUICK_CHAT_SETTINGS, persistent }}
			setQuickChatSettings={vi.fn()}
		/>
	);
}

describe('QuickChatSection', () => {
	it('puts the hotkey capture beside its heading, not centered below it', () => {
		renderSection();
		const row = document.querySelector('[data-setting-id="encore-quick-chat-hotkey"]')!;
		// A horizontal row: exactly `flex`, never stacked with `flex-col`.
		expect(row.classList.contains('flex')).toBe(true);
		expect(row.classList.contains('flex-col')).toBe(false);
		// Heading block first, then the capture button in its own trailing column.
		expect(row.children).toHaveLength(2);
		expect(row.children[0].textContent).toContain('Hotkey');
		expect(row.children[1].querySelector('button')).not.toBeNull();
	});

	it('names the bookmark, not the pin, as the control that keeps an ephemeral chat', () => {
		renderSection(false);
		expect(screen.getByText(/The bookmark in the window keeps one\./)).toBeInTheDocument();
		expect(screen.queryByText(/pin in the window/)).toBeNull();
	});

	it('defaults to Choose tab, explains both options, and saves New tab when picked', () => {
		const setQuickChatSettings = vi.fn();
		render(
			<QuickChatSection
				theme={mockTheme}
				quickChatSettings={{ ...DEFAULT_QUICK_CHAT_SETTINGS }}
				setQuickChatSettings={setQuickChatSettings}
			/>
		);
		const group = screen.getByRole('radiogroup', { name: 'Quick Chat default tab' });
		expect(group.closest('[data-setting-id="encore-quick-chat-default-tab"]')).not.toBeNull();
		expect(screen.getByRole('radio', { name: /Choose tab/ })).toBeChecked();
		expect(screen.getByText(/Maestro finds the tab for the first message/)).toBeInTheDocument();
		expect(screen.getByText(/Every chat starts in a new tab/)).toBeInTheDocument();

		fireEvent.click(screen.getByRole('radio', { name: /New tab/ }));
		expect(setQuickChatSettings).toHaveBeenCalledWith({
			...DEFAULT_QUICK_CHAT_SETTINGS,
			defaultTab: 'new',
		});
	});
});
