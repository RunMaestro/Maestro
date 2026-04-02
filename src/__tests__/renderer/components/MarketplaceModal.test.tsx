import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Theme } from '../../../renderer/types';
import { PlaybookDetailView } from '../../../renderer/components/MarketplaceModal';
import type { MarketplacePlaybook } from '../../../shared/marketplace-types';

function createMockTheme(): Theme {
	return {
		id: 'dark',
		name: 'Dark',
		mode: 'dark',
		colors: {
			bgMain: '#1a1a1a',
			bgSidebar: '#111111',
			bgActivity: '#222222',
			textMain: '#ffffff',
			textDim: '#888888',
			accent: '#0066ff',
			border: '#333333',
			success: '#00cc00',
			warning: '#ffcc00',
			error: '#ff0000',
			info: '#0099ff',
			link: '#66aaff',
			userBubble: '#0044cc',
		},
	};
}

function createPlaybook(overrides: Partial<MarketplacePlaybook> = {}): MarketplacePlaybook {
	return {
		id: 'pb-1',
		title: 'Test Playbook',
		description: 'Test description',
		category: 'Development',
		author: 'Test Author',
		lastUpdated: '2026-04-02',
		path: 'playbooks/test',
		documents: [{ filename: 'phase-1', resetOnCompletion: false }],
		loopEnabled: false,
		prompt: null,
		...overrides,
	};
}

function renderDetail(playbook: MarketplacePlaybook) {
	return render(
		<PlaybookDetailView
			theme={createMockTheme()}
			playbook={playbook}
			readmeContent="# README"
			selectedDocFilename={null}
			documentContent={null}
			isLoadingDocument={false}
			targetFolderName="target-folder"
			isImporting={false}
			isRemoteSession={false}
			onBack={vi.fn()}
			onSelectDocument={vi.fn()}
			onTargetFolderChange={vi.fn()}
			onBrowseFolder={vi.fn()}
			onImport={vi.fn()}
		/>
	);
}

describe('MarketplaceModal runtime settings display', () => {
	it('shows explicit runtime settings for marketplace playbooks', () => {
		renderDetail(
			createPlaybook({
				loopEnabled: true,
				maxLoops: 3,
				taskTimeoutMs: 45000,
				promptProfile: 'compact-doc',
				documentContextMode: 'full',
				skillPromptMode: 'full',
				agentStrategy: 'plan-execute-verify',
				skills: ['maestro-cli-playbooks', 'debugging-troubleshooting'],
			})
		);

		expect(screen.getByText('Loop: Yes (max 3)')).toBeInTheDocument();
		expect(screen.getByText('Timeout: 45000ms')).toBeInTheDocument();
		expect(screen.getByText('Profile: compact-doc')).toBeInTheDocument();
		expect(screen.getByText('Context: full')).toBeInTheDocument();
		expect(screen.getByText('Skill mode: full')).toBeInTheDocument();
		expect(screen.getByText('Strategy: plan-execute-verify')).toBeInTheDocument();
		expect(
			screen.getByText('Skills: maestro-cli-playbooks, debugging-troubleshooting')
		).toBeInTheDocument();
	});

	it('shows default runtime settings when optional fields are omitted', () => {
		renderDetail(createPlaybook());

		expect(screen.getByText('Loop: No')).toBeInTheDocument();
		expect(screen.getByText('Timeout: Default')).toBeInTheDocument();
		expect(screen.getByText('Profile: compact-code')).toBeInTheDocument();
		expect(screen.getByText('Context: active-task-only')).toBeInTheDocument();
		expect(screen.getByText('Skill mode: brief')).toBeInTheDocument();
		expect(screen.getByText('Strategy: single')).toBeInTheDocument();
		expect(screen.getByText('Skills: None')).toBeInTheDocument();
	});
});
