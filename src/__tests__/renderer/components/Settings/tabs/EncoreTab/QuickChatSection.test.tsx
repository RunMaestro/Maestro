import { render, screen } from '@testing-library/react';
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
});
