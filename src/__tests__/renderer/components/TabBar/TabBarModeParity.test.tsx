/**
 * @fileoverview The tab strip and a tab's hover menu draw the same for a local, an SSH, and a
 * hosted agent. A hosted agent's tabs come from its host through `projectHostedSession()`; the
 * strip takes them as it takes a local agent's, with only the `sshRemoteId` MainPanel passes
 * for any agent whose files live on a remote.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabBar } from '../../../../renderer/components/TabBar';
import type { TabBarProps } from '../../../../renderer/components/TabBar/types';
import { projectHostedSession } from '../../../../renderer/utils/hostedSession';
import { liveTurnKey } from '../../../../shared/maestro-lib/client/live-turn';
import type { LogEntryRecord } from '../../../../shared/maestro-lib/store/transcript';
import type {
	AITab,
	FilePreviewTab,
	LogEntry,
	Session,
	UnifiedTab,
} from '../../../../renderer/types';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab, createMockFileTab } from '../../../helpers/mockTab';
import { mockTheme } from '../../../helpers/mockTheme';

type Mode = 'local' | 'ssh' | 'hosted';
const MODES: Mode[] = ['local', 'ssh', 'hosted'];

const entry = (id: string, source: 'user' | 'ai', text: string): LogEntryRecord => ({
	id,
	timestamp: 1000,
	source,
	text,
});

const TRANSCRIPTS: Record<string, LogEntryRecord[]> = {
	t1: [entry('u1', 'user', 'Fix the build'), entry('a1', 'ai', 'Done.')],
	t2: [entry('u2', 'user', 'Notes please')],
};

const TAB_FIELDS = [
	{ id: 't1', name: 'Main', agentSessionId: 's1', starred: false, createdAt: 1000 },
	{ id: 't2', name: 'Notes', agentSessionId: 's2', starred: true, createdAt: 2000 },
];

/** The agent's tabs in each mode, as MainPanel hands them to the strip. */
function tabsFor(mode: Mode): AITab[] {
	if (mode !== 'hosted') {
		return TAB_FIELDS.map((fields) =>
			createMockAITab({
				...fields,
				logs: TRANSCRIPTS[fields.id].map((record) => ({ ...record }) as LogEntry),
			})
		);
	}
	const row: Session = createMockSession({
		id: 'row',
		sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
		liftedTo: { peer: 'box', agentId: 'h1', at: 1 },
		aiTabs: [],
		unifiedTabOrder: [],
		executionQueue: [],
	} as Partial<Session>);
	const projected = projectHostedSession(row, {
		agent: {
			id: 'h1',
			name: 'Docs',
			toolType: 'claude-code',
			activeTabId: 't1',
			aiTabs: TAB_FIELDS.map((fields) => ({ ...fields, state: 'idle' as const })),
		},
		transcripts: Object.fromEntries(
			TAB_FIELDS.map((fields) => [
				liveTurnKey('h1', fields.id),
				{ entries: TRANSCRIPTS[fields.id], loaded: true },
			])
		),
	});
	return projected.aiTabs;
}

const fileTab: FilePreviewTab = createMockFileTab({
	id: 'f1',
	path: '/home/user/project/README.md',
	name: 'README',
	extension: '.md',
});

function propsFor(mode: Mode): TabBarProps {
	const tabs = tabsFor(mode);
	const unifiedTabs: UnifiedTab[] = [
		...tabs.map((tab) => ({ type: 'ai' as const, id: tab.id, data: tab })),
		{ type: 'file' as const, id: fileTab.id, data: fileTab },
	];
	return {
		tabs,
		activeTabId: 't1',
		theme: mockTheme,
		sessionId: 'agent-1',
		unifiedTabs,
		activeFileTabId: null,
		onTabSelect: vi.fn(),
		onTabClose: vi.fn(),
		onNewTab: vi.fn(),
		onRequestRename: vi.fn(),
		onTabStar: vi.fn(),
		onTabMarkUnread: vi.fn(),
		onMergeWith: vi.fn(),
		onSendToAgent: vi.fn(),
		onSummarizeAndContinue: vi.fn(),
		onCopyContext: vi.fn(),
		onExportHtml: vi.fn(),
		onPublishGist: vi.fn(),
		ghCliAvailable: true,
		onCloseAllTabs: vi.fn(),
		onCloseOtherTabs: vi.fn(),
		onCloseTabsLeft: vi.fn(),
		onCloseTabsRight: vi.fn(),
		onFileTabSelect: vi.fn(),
		onFileTabClose: vi.fn(),
		onNewFileTab: vi.fn(),
		onNewTerminalTab: vi.fn(),
		// MainPanel: `filePreviewSshRemoteId`, set for SSH and hosted agents alike.
		sshRemoteId: mode === 'local' ? undefined : 'r1',
	} as TabBarProps;
}

/** The strip's markup, then the markup of the hover menu opened on `tabId`. */
function draw(mode: Mode, tabId: string): { strip: string; menu: string } {
	const { container } = render(<TabBar {...propsFor(mode)} />);
	const strip = container.innerHTML;
	const chip = container.querySelector(`[data-tab-id="${tabId}"]`)!;
	act(() => {
		fireEvent.mouseEnter(chip);
		vi.advanceTimersByTime(450);
	});
	const menu = Array.from(document.body.children)
		.filter((node) => !node.contains(container))
		.map((node) => node.outerHTML)
		.join('');
	cleanup();
	return { strip, menu };
}

describe('the tab strip: local, SSH, and hosted agents', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		Element.prototype.scrollTo = vi.fn();
		Element.prototype.scrollIntoView = vi.fn();
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it('draws the same chips, names, stars, and buttons in every mode', () => {
		const [local, ssh, hosted] = MODES.map((mode) => draw(mode, 't1').strip);
		expect(local).toContain('Main');
		expect(local).toContain('Notes');
		expect(ssh).toBe(local);
		expect(hosted).toBe(local);
	});

	it('opens the same AI tab hover menu with the same rows in every mode', () => {
		const [local, ssh, hosted] = MODES.map((mode) => draw(mode, 't2').menu);
		for (const row of ['Copy Session ID', 'Rename Tab', 'Close Tab']) expect(local).toContain(row);
		expect(ssh).toBe(local);
		expect(hosted).toBe(local);
	});

	it('draws the same file tab menu, Reveal and Open in Default App included, in every mode', () => {
		const [local, ssh, hosted] = MODES.map((mode) => draw(mode, 'f1').menu);
		expect(local).toMatch(/Reveal in (Finder|Explorer|File Manager)/);
		expect(local).toContain('Open in Default App');
		expect(ssh).toBe(local);
		expect(hosted).toBe(local);
	});
});
