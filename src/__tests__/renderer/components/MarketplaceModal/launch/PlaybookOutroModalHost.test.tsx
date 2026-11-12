/**
 * Tests for PlaybookOutroModalHost: it mounts the outro from the modal store and closes the store
 * entry on every way out. The dialog itself has its own suite, so a stand-in records the props the
 * host gives it and lets a test press Close or Open.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { PlaybookOutroModalProps } from '../../../../../renderer/components/MarketplaceModal/launch/PlaybookOutroModal';

const dialog = vi.hoisted(() => ({
	props: null as Record<string, any> | null,
	mounts: 0,
}));

vi.mock(
	'../../../../../renderer/components/MarketplaceModal/launch/PlaybookOutroModal',
	async () => {
		const { useEffect } = await import('react');
		return {
			PlaybookOutroModal: (props: PlaybookOutroModalProps) => {
				dialog.props = props;
				// Counts mounts, not draws: a launch that replaces another must start the dialog clean.
				useEffect(() => {
					dialog.mounts += 1;
				}, []);
				return (
					<div data-testid="outro-dialog-stub" data-launch-id={props.launch.launchId}>
						<button type="button" onClick={props.onClose}>
							Close
						</button>
						<button type="button" onClick={() => props.onOpenFile('/work/Docs/REPORT.md')}>
							Open report
						</button>
					</div>
				);
			},
		};
	}
);

import { PlaybookOutroModalHost } from '../../../../../renderer/components/MarketplaceModal/launch/PlaybookOutroModalHost';
import { getModalActions, useModalStore } from '../../../../../renderer/stores/modalStore';
import { createMockLaunchRecord } from '../../../../helpers';
import { mockTheme } from '../../../../helpers/mockTheme';

const launch = createMockLaunchRecord({
	launchId: 'launch-7',
	status: 'completed',
	cleanup: 'done',
});

const outroOpen = () => useModalStore.getState().isOpen('playbookOutro');

beforeEach(() => {
	vi.clearAllMocks();
	dialog.props = null;
	dialog.mounts = 0;
	useModalStore.setState({ modals: new Map() });
});

describe('PlaybookOutroModalHost', () => {
	it('draws nothing while no launch is set', () => {
		const { container } = render(<PlaybookOutroModalHost theme={mockTheme} onOpenFile={vi.fn()} />);

		expect(container.firstChild).toBeNull();
		expect(dialog.props).toBeNull();
	});

	it('draws the outro for the launch the store holds, exactly as main broadcast it', () => {
		render(<PlaybookOutroModalHost theme={mockTheme} onOpenFile={vi.fn()} />);

		act(() => getModalActions().openPlaybookOutro(launch));

		expect(screen.getByTestId('outro-dialog-stub').getAttribute('data-launch-id')).toBe('launch-7');
		expect(dialog.props?.launch).toBe(launch);
		expect(dialog.props?.theme).toBe(mockTheme);
	});

	it('goes away when the store closes the outro', () => {
		render(<PlaybookOutroModalHost theme={mockTheme} onOpenFile={vi.fn()} />);
		act(() => getModalActions().openPlaybookOutro(launch));

		act(() => getModalActions().closePlaybookOutro());

		expect(screen.queryByTestId('outro-dialog-stub')).toBeNull();
	});

	it('closes the store entry when the dialog asks to close', () => {
		render(<PlaybookOutroModalHost theme={mockTheme} onOpenFile={vi.fn()} />);
		act(() => getModalActions().openPlaybookOutro(launch));
		expect(outroOpen()).toBe(true);

		fireEvent.click(screen.getByText('Close'));

		expect(outroOpen()).toBe(false);
		expect(screen.queryByTestId('outro-dialog-stub')).toBeNull();
	});

	it('hands the dialog the app open-file path, untouched', () => {
		const onOpenFile = vi.fn();
		render(<PlaybookOutroModalHost theme={mockTheme} onOpenFile={onOpenFile} />);
		act(() => getModalActions().openPlaybookOutro(launch));

		fireEvent.click(screen.getByText('Open report'));

		expect(onOpenFile).toHaveBeenCalledTimes(1);
		expect(onOpenFile).toHaveBeenCalledWith('/work/Docs/REPORT.md');
		// The dialog decides when to close after an Open; the host does not close it on its own.
		expect(outroOpen()).toBe(true);
	});

	it('starts a clean dialog when another launch replaces the one on screen', () => {
		render(<PlaybookOutroModalHost theme={mockTheme} onOpenFile={vi.fn()} />);
		act(() => getModalActions().openPlaybookOutro(launch));
		expect(dialog.mounts).toBe(1);

		act(() =>
			getModalActions().openPlaybookOutro(
				createMockLaunchRecord({ launchId: 'launch-8', status: 'stopped' })
			)
		);

		expect(screen.getByTestId('outro-dialog-stub').getAttribute('data-launch-id')).toBe('launch-8');
		expect(dialog.mounts).toBe(2);
	});

	it('keeps the same dialog when the same launch is set again', () => {
		render(<PlaybookOutroModalHost theme={mockTheme} onOpenFile={vi.fn()} />);
		act(() => getModalActions().openPlaybookOutro(launch));

		act(() => getModalActions().openPlaybookOutro({ ...launch }));

		expect(dialog.mounts).toBe(1);
	});
});
