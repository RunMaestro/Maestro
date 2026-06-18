/**
 * Tests for AutoRunInline empty-state Docs Overview CTAs.
 *
 * @file src/web/mobile/AutoRunInline.tsx
 *
 * Covers Gap 3 from the AutoRun mobile/web parity follow-up: the empty
 * state must surface BOTH "Create document" and "Browse Playbook Exchange"
 * as co-equal CTAs so mobile users have a path to discover existing
 * playbooks (not just create blank docs).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { AutoRunInline } from '../../../web/mobile/AutoRunInline';

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		bgMain: '#0b0b0d',
		bgSidebar: '#111113',
		bgActivity: '#1c1c1f',
		border: '#27272a',
		textMain: '#e4e4e7',
		textDim: '#a1a1aa',
		accent: '#6366f1',
		accentForeground: '#ffffff',
		accentDim: 'rgba(99, 102, 241, 0.2)',
		accentText: '#a5b4fc',
		success: '#22c55e',
		warning: '#eab308',
		error: '#ef4444',
	}),
}));

// MarkdownRenderer pulls in remark/rehype which is not relevant to the empty
// state and slows the test boot down considerably.
vi.mock('../../../web/mobile/MobileMarkdownRenderer', () => ({
	MobileMarkdownRenderer: () => null,
	TaskAwareMarkdown: () => null,
}));

vi.mock('../../../web/mobile/AutoRunIndicator', () => ({
	AutoRunIndicator: () => null,
}));

// Default useAutoRun mock — empty docs list so the empty state renders.
vi.mock('../../../web/hooks/useAutoRun', () => ({
	useAutoRun: () => ({
		documents: [],
		isLoadingDocs: false,
		loadDocuments: vi.fn(),
		saveDocumentContent: vi.fn().mockResolvedValue(true),
		resetDocumentTasks: vi.fn().mockResolvedValue(true),
		stopAutoRun: vi.fn().mockResolvedValue(true),
	}),
}));

const baseProps = {
	sessionId: 'session-1',
	autoRunState: null,
	sendRequest: vi.fn(),
	send: vi.fn(),
	onOpenSetup: vi.fn(),
};

describe('AutoRunInline — empty-state Docs Overview CTAs', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders the "+ Create document" CTA in the empty state', () => {
		render(<AutoRunInline {...baseProps} />);
		expect(screen.getByRole('button', { name: /Create document/i })).toBeInTheDocument();
	});

	it('hides the "Browse Playbook Exchange" CTA when onOpenMarketplace is omitted', () => {
		render(<AutoRunInline {...baseProps} />);
		expect(
			screen.queryByRole('button', { name: /Browse Playbook Exchange/i })
		).not.toBeInTheDocument();
	});

	it('renders the "Browse Playbook Exchange" CTA when onOpenMarketplace is provided', () => {
		const onOpenMarketplace = vi.fn();
		render(<AutoRunInline {...baseProps} onOpenMarketplace={onOpenMarketplace} />);
		expect(screen.getByRole('button', { name: /Browse Playbook Exchange/i })).toBeInTheDocument();
	});

	it('invokes onOpenMarketplace when the CTA is clicked', () => {
		const onOpenMarketplace = vi.fn();
		render(<AutoRunInline {...baseProps} onOpenMarketplace={onOpenMarketplace} />);
		fireEvent.click(screen.getByRole('button', { name: /Browse Playbook Exchange/i }));
		expect(onOpenMarketplace).toHaveBeenCalledTimes(1);
	});
});
