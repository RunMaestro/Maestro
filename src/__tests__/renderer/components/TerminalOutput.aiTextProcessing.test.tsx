import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TerminalOutput } from '../../../renderer/components/TerminalOutput';
import type { Session, Theme, LogEntry } from '../../../renderer/types';

const mockRegisterLayer = vi.fn().mockReturnValue('layer-1');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

const theme: Theme = {
	id: 'test-theme' as Theme['id'],
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#1a1a1a',
		bgActivity: '#222222',
		textMain: '#f5f5f5',
		textDim: '#9ca3af',
		accent: '#3b82f6',
		accentText: '#ffffff',
		accentDim: '#2563eb',
		accentForeground: '#ffffff',
		border: '#374151',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const createLog = (text: string): LogEntry => ({
	id: 'log-1',
	text,
	timestamp: Date.now(),
	source: 'stdout',
});

const createSession = (text: string): Session =>
	({
		id: 'session-1',
		cwd: '/tmp/project',
		activeTabId: 'tab-1',
		aiTabs: [
			{
				id: 'tab-1',
				logs: [createLog(text)],
			},
		],
	}) as unknown as Session;

const createProps = (session: Session): React.ComponentProps<typeof TerminalOutput> => ({
	session,
	theme,
	fontFamily: 'monospace',
	activeFocus: 'main',
	outputSearchOpen: false,
	outputSearchQuery: '',
	setOutputSearchOpen: vi.fn(),
	setOutputSearchQuery: vi.fn(),
	setActiveFocus: vi.fn(),
	setLightboxImage: vi.fn(),
	inputRef: { current: null } as React.RefObject<HTMLTextAreaElement>,
	logsEndRef: { current: null } as React.RefObject<HTMLDivElement>,
	maxOutputLines: 200,
	markdownEditMode: true,
	setMarkdownEditMode: vi.fn(),
});

describe('TerminalOutput AI-mode text processing', () => {
	it('preserves shell prompt text in log output', () => {
		const session = createSession('output\nbash-3.2$ \nmore output');

		const { queryByText } = render(<TerminalOutput {...createProps(session)} />);

		expect(queryByText(/bash-3\.2\$/)).toBeTruthy();
	});
});
