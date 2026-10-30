/**
 * The Sketch tab chip's busy dot: it shows while an agent works on the sketch
 * (`useSketchAgentWork()`) and names the work in the chip's title.
 */

import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SketchTabItem } from '../../../../renderer/components/TabBar/SketchTabItem';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSketchSessionStore } from '../../../../renderer/stores/sketchSessionStore';
import type { SketchTab } from '../../../../shared/sketch/types';
import { createMockAITab, createMockSession } from '../../../helpers';
import { mockTheme } from '../../../helpers/mockTheme';

const tab: SketchTab = { id: 'tab-1', sketchId: 'sketch-1', name: 'Flow', createdAt: 1 };

function renderChip() {
	return render(
		<SketchTabItem
			tab={tab}
			isActive={false}
			theme={mockTheme}
			onSelect={vi.fn()}
			onClose={vi.fn()}
			onDragStart={vi.fn()}
			onDragOver={vi.fn()}
			onDragEnd={vi.fn()}
			onDrop={vi.fn()}
			isDragging={false}
			isDragOver={false}
		/>
	);
}

describe('SketchTabItem working dot', () => {
	beforeEach(() => {
		useSketchSessionStore.setState({ sessions: {}, agentActivity: {} });
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 'ada',
					name: 'Ada',
					aiTabs: [createMockAITab({ id: 'work', state: 'busy', thinkingStartTime: 100 })],
				}),
			],
		});
	});

	it('shows no dot while the agent is idle on the sketch', () => {
		renderChip();
		expect(screen.queryByTestId('sketch-tab-working')).toBeNull();
		expect(screen.getByTitle('Flow')).toBeTruthy();
	});

	it('shows the dot and names the work while the agent draws on the sketch', () => {
		renderChip();
		act(() => {
			useSketchSessionStore
				.getState()
				.noteSketchAgentActivity({ agentId: 'ada', sketchId: 'sketch-1', writes: true }, 150);
		});
		expect(screen.getByTestId('sketch-tab-working').getAttribute('aria-label')).toBe(
			'Ada is drawing'
		);
		expect(screen.getByTitle('Flow (Ada is drawing)')).toBeTruthy();
	});
});
