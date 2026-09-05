/**
 * Tests for the composer's font, which is what tells you at a glance whether
 * what you are typing is a shell line or a sentence.
 *
 * Command mode and the terminal composer take a fixed-pitch face - a command
 * line is shell text, and the card it ends up in renders it the same way. AI
 * command mode does not: that draft is prose, and the command the model
 * proposes gets monospace when it appears in the proposal card.
 */

import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';
import { InputTextarea } from '../../../../../renderer/components/InputArea/components/InputTextarea';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { createInputAreaSession, inputAreaTheme } from '../_fixtures';

function renderTextarea(props: Record<string, unknown> = {}) {
	return render(
		<InputTextarea
			session={createInputAreaSession()}
			theme={inputAreaTheme}
			isTerminalMode={false}
			isCommandModeDraft={false}
			isAiCommandDraft={false}
			awaitingAiCommand={false}
			inputValue=""
			spellCheckEnabled={false}
			inputRef={createRef<HTMLTextAreaElement>()}
			onInputFocus={() => {}}
			onChange={() => {}}
			handleInputKeyDown={() => {}}
			handlePaste={() => {}}
			handleDrop={() => {}}
			{...props}
		/>
	);
}

function textarea(): HTMLTextAreaElement {
	return screen.getByRole('textbox') as HTMLTextAreaElement;
}

beforeEach(() => {
	// A real proportional face, and the one this was found with: it resolves
	// perfectly well, so no amount of fallback appending fixes it on its own.
	useSettingsStore.setState({ fontFamily: 'Avenir Next' });
});

describe('InputTextarea font', () => {
	it('types a command-mode draft in a fixed-pitch stack', () => {
		renderTextarea({ isCommandModeDraft: true });

		expect(textarea().style.fontFamily).toMatch(/monospace/);
	});

	it('types a terminal-mode command in a fixed-pitch stack', () => {
		renderTextarea({ isTerminalMode: true });

		expect(textarea().style.fontFamily).toMatch(/monospace/);
	});

	it('leaves an AI command request in the app font', () => {
		renderTextarea({ isAiCommandDraft: true });

		expect(textarea().style.fontFamily).toBe('');
	});

	it('leaves an ordinary agent message in the app font', () => {
		renderTextarea();

		expect(textarea().style.fontFamily).toBe('');
	});
});
