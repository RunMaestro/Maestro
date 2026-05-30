/**
 * Tests for FolderPickerSheet typeable path input.
 *
 * @file src/web/mobile/FolderPickerSheet.tsx
 *
 * Covers the PR #895 follow-up parity gap: desktop AutoRunSetupModal lets
 * users paste/type a folder path; the mobile sheet was tree-only. This
 * test verifies the new typeable input updates the selection and that
 * the typed path is what gets passed to onConfirm.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { FolderPickerSheet } from '../../../web/mobile/FolderPickerSheet';

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		bgMain: '#0b0b0d',
		bgSidebar: '#111113',
		bgActivity: '#1c1c1f',
		border: '#27272a',
		textMain: '#e4e4e7',
		textDim: '#a1a1aa',
		accent: '#6366f1',
		accentDim: 'rgba(99, 102, 241, 0.2)',
		accentText: '#a5b4fc',
		success: '#22c55e',
		warning: '#eab308',
		error: '#ef4444',
	}),
}));

vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: vi.fn(),
	HAPTIC_PATTERNS: { tap: 10, success: [10, 30, 10], error: [50, 50, 50] },
}));

describe('FolderPickerSheet typeable path input', () => {
	let sendRequest: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		sendRequest = vi.fn().mockResolvedValue({ tree: [] });
	});

	it('renders an editable input for the folder path', async () => {
		render(
			<FolderPickerSheet
				sessionId="s1"
				startPath="/Users/test/project"
				onClose={vi.fn()}
				onConfirm={vi.fn()}
				sendRequest={sendRequest}
			/>
		);
		const input = await screen.findByLabelText('Auto Run folder path');
		expect(input).toBeInstanceOf(HTMLInputElement);
		expect((input as HTMLInputElement).value).toBe('');
	});

	it('pre-fills the input with initialPath', async () => {
		render(
			<FolderPickerSheet
				sessionId="s1"
				startPath="/Users/test/project"
				initialPath="/Users/test/project/docs"
				onClose={vi.fn()}
				onConfirm={vi.fn()}
				sendRequest={sendRequest}
			/>
		);
		const input = await screen.findByLabelText<HTMLInputElement>('Auto Run folder path');
		expect(input.value).toBe('/Users/test/project/docs');
	});

	it('passes the typed path to onConfirm when the user confirms', async () => {
		const onConfirm = vi.fn().mockResolvedValue(undefined);
		render(
			<FolderPickerSheet
				sessionId="s1"
				startPath="/Users/test/project"
				onClose={vi.fn()}
				onConfirm={onConfirm}
				sendRequest={sendRequest}
			/>
		);
		const input = await screen.findByLabelText('Auto Run folder path');
		fireEvent.change(input, { target: { value: '/Users/test/project/playbooks' } });

		const confirmBtn = screen.getByRole('button', { name: /use this folder/i });
		fireEvent.click(confirmBtn);

		await waitFor(() => {
			expect(onConfirm).toHaveBeenCalledWith('/Users/test/project/playbooks');
		});
	});

	it('keeps the confirm button disabled until the user types or selects a folder', async () => {
		render(
			<FolderPickerSheet
				sessionId="s1"
				startPath="/Users/test/project"
				onClose={vi.fn()}
				onConfirm={vi.fn()}
				sendRequest={sendRequest}
			/>
		);
		const confirmBtn = await screen.findByRole('button', { name: /use this folder/i });
		expect(confirmBtn).toBeDisabled();

		const input = screen.getByLabelText('Auto Run folder path');
		fireEvent.change(input, { target: { value: '/somewhere' } });
		expect(confirmBtn).not.toBeDisabled();
	});

	it('keeps the confirm button disabled for whitespace-only input', async () => {
		render(
			<FolderPickerSheet
				sessionId="s1"
				startPath="/Users/test/project"
				onClose={vi.fn()}
				onConfirm={vi.fn()}
				sendRequest={sendRequest}
			/>
		);
		const confirmBtn = await screen.findByRole('button', { name: /use this folder/i });
		const input = screen.getByLabelText('Auto Run folder path');
		fireEvent.change(input, { target: { value: '   ' } });
		expect(confirmBtn).toBeDisabled();
	});

	it('strips trailing slashes and whitespace before passing to onConfirm', async () => {
		const onConfirm = vi.fn().mockResolvedValue(undefined);
		render(
			<FolderPickerSheet
				sessionId="s1"
				startPath="/Users/test/project"
				onClose={vi.fn()}
				onConfirm={onConfirm}
				sendRequest={sendRequest}
			/>
		);
		const input = await screen.findByLabelText('Auto Run folder path');
		fireEvent.change(input, { target: { value: '  /Users/test/project/playbooks/  ' } });

		const confirmBtn = screen.getByRole('button', { name: /use this folder/i });
		fireEvent.click(confirmBtn);

		await waitFor(() => {
			expect(onConfirm).toHaveBeenCalledWith('/Users/test/project/playbooks');
		});
	});

	it('preserves a bare root path when normalizing', async () => {
		const onConfirm = vi.fn().mockResolvedValue(undefined);
		render(
			<FolderPickerSheet
				sessionId="s1"
				startPath="/"
				onClose={vi.fn()}
				onConfirm={onConfirm}
				sendRequest={sendRequest}
			/>
		);
		const input = await screen.findByLabelText('Auto Run folder path');
		fireEvent.change(input, { target: { value: '/' } });

		const confirmBtn = screen.getByRole('button', { name: /use this folder/i });
		fireEvent.click(confirmBtn);

		await waitFor(() => {
			expect(onConfirm).toHaveBeenCalledWith('/');
		});
	});
});
