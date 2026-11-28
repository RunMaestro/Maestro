/**
 * @fileoverview The mode pill is the one visual difference between a local, an SSH, and a hosted
 * agent. A Left Bar row and the collapsed Left Bar's hover card draw it once (LOCAL, REMOTE, or
 * HOSTED) and draw everything else the same in all three modes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SessionItem } from '../../../renderer/components/SessionItem';
import { SessionTooltipContent } from '../../../renderer/components/SessionList/SessionTooltipContent';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import {
	createMirroredPeer,
	replacePeerAgents,
	setPeerConnection,
} from '../../../shared/maestro-lib/client/peer-mirror';
import type { Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';
import { resetStores } from '../../helpers';

const ssh = { enabled: true, remoteId: 'r1' };

function modes(overrides: Partial<Session> = {}): Record<'local' | 'ssh' | 'hosted', Session> {
	const base = {
		id: 'agent-1',
		name: 'Docs',
		cwd: '/home/user/project',
		fullPath: '/home/user/project',
		projectRoot: '/home/user/project',
		isGitRepo: true,
		contextUsage: 30,
		activeTimeMs: 60000,
		...overrides,
	};
	return {
		local: createMockSession(base),
		ssh: createMockSession({ ...base, sessionSshRemoteConfig: ssh } as Partial<Session>),
		hosted: createMockSession({
			...base,
			sessionSshRemoteConfig: ssh,
			liftedTo: { peer: 'box', agentId: 'h1', at: 1 },
		} as Partial<Session>),
	};
}

const rowProps = {
	variant: 'flat' as const,
	theme: mockTheme,
	isActive: false,
	isKeyboardSelected: false,
	isDragging: false,
	isEditing: false,
	leftSidebarOpen: true,
	onSelect: vi.fn(),
	onDragStart: vi.fn(),
	onContextMenu: vi.fn(),
	onFinishRename: vi.fn(),
	onStartRename: vi.fn(),
	onToggleBookmark: vi.fn(),
};

/** The markup with the mode pill (and its hover wrapper) taken out, and the pills it drew. */
function drawWithoutModePill(ui: React.ReactElement): { html: string; pills: string[] } {
	const { container } = render(ui);
	const clone = container.cloneNode(true) as HTMLElement;
	const pills = Array.from(clone.querySelectorAll('[data-testid^="federation-badge-"]')).map(
		(pill) => pill.textContent ?? ''
	);
	clone
		.querySelectorAll('[data-testid^="federation-badge-"]')
		.forEach((pill) => pill.parentElement?.remove());
	cleanup();
	return { html: clone.innerHTML, pills };
}

describe('the mode pill: local, SSH, and hosted agents', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore);
		const { peer } = replacePeerAgents(
			createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Build Box' }),
			[{ id: 'h1', name: 'Docs', toolType: 'claude-code', aiTabs: [] }],
			[],
			1
		);
		usePeerMirrorStore.getState().hydrate([setPeerConnection(peer, 'connected').peer]);
		useSettingsStore.setState({ federationHostedAgents: true, showLeftPanelLocationPills: true });
	});

	afterEach(() => {
		useSettingsStore.setState({ federationHostedAgents: false });
	});

	for (const isGitRepo of [true, false]) {
		it(`a Left Bar row draws one pill and nothing else differs (${isGitRepo ? 'git' : 'plain'} directory)`, () => {
			const agents = modes({ isGitRepo });
			const local = drawWithoutModePill(<SessionItem {...rowProps} session={agents.local} />);
			const sshRow = drawWithoutModePill(<SessionItem {...rowProps} session={agents.ssh} />);
			const hosted = drawWithoutModePill(<SessionItem {...rowProps} session={agents.hosted} />);
			expect([local.pills, sshRow.pills, hosted.pills]).toEqual([
				['LOCAL'],
				['REMOTE'],
				['HOSTED'],
			]);
			expect(sshRow.html).toBe(local.html);
			expect(hosted.html).toBe(local.html);
			// The GIT pill says "git repository" in every mode, and only that.
			render(<SessionItem {...rowProps} session={agents.hosted} />);
			expect(screen.queryAllByText('GIT')).toHaveLength(isGitRepo ? 1 : 0);
		});
	}

	it('a bookmarked row draws the same pill in every mode', () => {
		const agents = modes();
		const props = { ...rowProps, variant: 'bookmark' as const };
		const local = drawWithoutModePill(<SessionItem {...props} session={agents.local} />);
		const hosted = drawWithoutModePill(<SessionItem {...props} session={agents.hosted} />);
		expect(local.pills).toEqual(['LOCAL']);
		expect(hosted.pills).toEqual(['HOSTED']);
		expect(hosted.html).toBe(local.html);
	});

	it("the collapsed Left Bar's hover card draws one pill and nothing else differs", () => {
		const agents = modes();
		const local = drawWithoutModePill(
			<SessionTooltipContent session={agents.local} theme={mockTheme} />
		);
		const sshCard = drawWithoutModePill(
			<SessionTooltipContent session={agents.ssh} theme={mockTheme} />
		);
		const hosted = drawWithoutModePill(
			<SessionTooltipContent session={agents.hosted} theme={mockTheme} />
		);
		expect([local.pills, sshCard.pills, hosted.pills]).toEqual([['LOCAL'], ['REMOTE'], ['HOSTED']]);
		expect(sshCard.html).toBe(local.html);
		expect(hosted.html).toBe(local.html);
	});
});
