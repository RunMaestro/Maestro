import React, { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TerminalOutput } from '../../../../renderer/components/TerminalOutput/TerminalOutput';
import type {
	LogItemProps,
	TerminalOutputProps,
} from '../../../../renderer/components/TerminalOutput/types';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab } from '../../../helpers/mockTab';
import { mockTheme } from '../../../helpers/mockTheme';

vi.mock('../../../../renderer/components/TerminalOutput/components/LogItem', () => ({
	LogItem: ({ log, codexDirectives }: Pick<LogItemProps, 'log' | 'codexDirectives'>) => (
		<div data-testid={log.id} data-codex-directives={String(codexDirectives)} />
	),
}));

describe('transcript directive ownership', () => {
	it('uses each entry owner across selection changes, leaving legacy entries unattributed', () => {
		const tab = createMockAITab({
			logs: [
				{ id: 'codex', timestamp: 1, source: 'stdout', text: 'Codex offer', turnProvider: 'codex' },
				{
					id: 'claude',
					timestamp: 2,
					source: 'stdout',
					text: 'Claude quote',
					turnProvider: 'claude-code',
				},
				{ id: 'legacy', timestamp: 3, source: 'stdout', text: 'Unknown owner' },
			],
		});
		const session = createMockSession({ toolType: 'codex', aiTabs: [tab], activeTabId: tab.id });
		const props: TerminalOutputProps = {
			session,
			theme: mockTheme,
			fontFamily: 'monospace',
			activeFocus: 'main',
			outputSearchOpen: false,
			outputSearchQuery: '',
			outputSearchRegex: false,
			setOutputSearchOpen: vi.fn(),
			setOutputSearchQuery: vi.fn(),
			setOutputSearchRegex: vi.fn(),
			setActiveFocus: vi.fn(),
			setLightboxImage: vi.fn(),
			inputRef: createRef<HTMLTextAreaElement>(),
			logsEndRef: createRef<HTMLDivElement>(),
			maxOutputLines: 1000,
			markdownEditMode: false,
			setMarkdownEditMode: vi.fn(),
		};
		const { rerender } = render(
			<LayerStackProvider>
				<TerminalOutput {...props} />
			</LayerStackProvider>
		);
		expect(screen.getByTestId('codex')).toHaveAttribute('data-codex-directives', 'true');
		expect(screen.getByTestId('claude')).toHaveAttribute('data-codex-directives', 'false');
		expect(screen.getByTestId('legacy')).toHaveAttribute('data-codex-directives', 'false');
		rerender(
			<LayerStackProvider>
				<TerminalOutput {...props} session={{ ...session, toolType: 'claude-code' }} />
			</LayerStackProvider>
		);
		expect(screen.getByTestId('codex')).toHaveAttribute('data-codex-directives', 'true');
	});
});
