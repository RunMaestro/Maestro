import React, { createRef } from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { TerminalOutput } from '../../../../renderer/components/TerminalOutput/TerminalOutput';
import type { TerminalOutputProps } from '../../../../renderer/components/TerminalOutput/types';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { createMockSession } from '../../../helpers/mockSession';
import { mockTheme } from '../../../helpers/mockTheme';

/**
 * Regression coverage for the Alt+J "Jump to Bottom" contract.
 *
 * useMainKeyboardHandler resolves the transcript scroll target via
 * `logsEndRef.current.parentElement` (one level up from the end marker). That
 * only works while the marker is a DIRECT child of the `overflow-y-auto` scroll
 * container. The content-resize re-pin work added a `contentRef` wrapper around
 * the log entries; if the end marker gets pulled inside that wrapper,
 * `parentElement` lands on an unscrollable block and Alt+J silently no-ops.
 *
 * This asserts the DOM relationship the keyboard handler depends on so nobody
 * re-nests the marker while refactoring this subtree.
 */
function makeProps(logsEndRef: React.RefObject<HTMLDivElement>): TerminalOutputProps {
	const noop = () => {};
	return {
		session: createMockSession(),
		theme: mockTheme,
		fontFamily: 'monospace',
		activeFocus: 'main',
		outputSearchOpen: false,
		outputSearchQuery: '',
		outputSearchRegex: false,
		setOutputSearchOpen: noop,
		setOutputSearchQuery: noop,
		setOutputSearchRegex: noop,
		setActiveFocus: noop,
		setLightboxImage: noop,
		inputRef: createRef<HTMLTextAreaElement>(),
		logsEndRef,
		maxOutputLines: 1000,
		markdownEditMode: false,
		setMarkdownEditMode: noop,
	};
}

describe('TerminalOutput scroll-container / end-marker contract', () => {
	it('renders logsEndRef as a direct child of the overflow-y-auto scroll container', () => {
		const logsEndRef = createRef<HTMLDivElement>();
		render(
			<LayerStackProvider>
				<TerminalOutput {...makeProps(logsEndRef)} />
			</LayerStackProvider>
		);

		const marker = logsEndRef.current;
		expect(marker).not.toBeNull();

		// Alt+J resolves the scroll target as the marker's parentElement, so the
		// parent MUST be the scroll container (the overflow-y-auto element), not the
		// unstyled contentRef wrapper that holds the log entries.
		const parent = marker!.parentElement;
		expect(parent).not.toBeNull();
		expect(parent!.className).toContain('overflow-y-auto');
	});
});
