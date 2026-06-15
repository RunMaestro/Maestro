import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mockTheme } from '../../../../../helpers/mockTheme';
import {
	DirectoryContinueButton,
	DirectoryKeyboardHints,
	DirectoryPathField,
	DirectorySelectionHeader,
	DirectorySelectionLoading,
	DirectoryStatusPanel,
} from '../../../../../../renderer/components/Wizard/screens/DirectorySelectionScreen/components';

describe('DirectorySelectionScreen components', () => {
	it('renders loading, header, and keyboard hints', () => {
		render(
			<>
				<DirectorySelectionLoading theme={mockTheme} />
				<DirectorySelectionHeader theme={mockTheme} agentName="Planner" yoloFlag="codex --yolo" />
				<DirectoryKeyboardHints theme={mockTheme} />
			</>
		);

		expect(screen.getByText('Detecting project location...')).toBeInTheDocument();
		expect(screen.getByText("Howdy, I'm Planner")).toBeInTheDocument();
		expect(screen.getByText('codex --yolo')).toBeInTheDocument();
		expect(screen.getByText('Navigate')).toBeInTheDocument();
	});

	it('renders local path field with browse and error states', () => {
		const onPathChange = vi.fn();
		const onBrowse = vi.fn();
		const inputRef = React.createRef<HTMLInputElement>();
		const browseButtonRef = React.createRef<HTMLButtonElement>();

		render(
			<DirectoryPathField
				theme={mockTheme}
				directoryPath="/bad"
				directoryError="Directory not found. Please check the path exists."
				isRemoteSession={false}
				sshRemoteHost={null}
				isBrowsing={false}
				inputRef={inputRef}
				browseButtonRef={browseButtonRef}
				onPathChange={onPathChange}
				onBrowse={onBrowse}
			/>
		);

		fireEvent.change(screen.getByLabelText('Project Directory'), {
			target: { value: '/next' },
		});
		fireEvent.click(screen.getByRole('button', { name: /browse/i }));

		expect(onPathChange).toHaveBeenCalled();
		expect(onBrowse).toHaveBeenCalled();
		expect(
			screen.getByText('Directory not found. Please check the path exists.')
		).toBeInTheDocument();
	});

	it('renders remote path hint without browse button', () => {
		render(
			<DirectoryPathField
				theme={mockTheme}
				directoryPath="/srv/project"
				directoryError={null}
				isRemoteSession={true}
				sshRemoteHost="Build Box"
				isBrowsing={false}
				inputRef={React.createRef<HTMLInputElement>()}
				browseButtonRef={React.createRef<HTMLButtonElement>()}
				onPathChange={vi.fn()}
				onBrowse={vi.fn()}
			/>
		);

		expect(screen.queryByRole('button', { name: /browse/i })).not.toBeInTheDocument();
		expect(screen.getByText(/Build Box/)).toBeInTheDocument();
	});

	it('renders git, regular, and validating status states', () => {
		const { rerender } = render(
			<DirectoryStatusPanel
				theme={mockTheme}
				directoryPath="/repo"
				directoryError={null}
				isGitRepo={true}
				isValidating={false}
				isInitializingRepo={false}
				initRepoError={null}
				onInitRepo={vi.fn()}
			/>
		);
		expect(screen.getByText('Git Repository Detected')).toBeInTheDocument();

		const onInitRepo = vi.fn();
		rerender(
			<DirectoryStatusPanel
				theme={mockTheme}
				directoryPath="/folder"
				directoryError={null}
				isGitRepo={false}
				isValidating={false}
				isInitializingRepo={false}
				initRepoError="No git"
				onInitRepo={onInitRepo}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: /initialize as git/i }));
		expect(onInitRepo).toHaveBeenCalled();
		expect(screen.getByText('No git')).toBeInTheDocument();

		rerender(
			<DirectoryStatusPanel
				theme={mockTheme}
				directoryPath="/folder"
				directoryError={null}
				isGitRepo={false}
				isValidating={true}
				isInitializingRepo={false}
				initRepoError={null}
				onInitRepo={vi.fn()}
			/>
		);
		expect(screen.getByText('Validating directory...')).toBeInTheDocument();
	});

	it('renders continue button only when visible and forwards clicks', () => {
		const onContinue = vi.fn();
		const { rerender } = render(
			<DirectoryContinueButton
				theme={mockTheme}
				show={false}
				isValid={true}
				isValidating={false}
				buttonRef={React.createRef<HTMLButtonElement>()}
				onContinue={onContinue}
			/>
		);

		expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();

		rerender(
			<DirectoryContinueButton
				theme={mockTheme}
				show={true}
				isValid={true}
				isValidating={false}
				buttonRef={React.createRef<HTMLButtonElement>()}
				onContinue={onContinue}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		expect(onContinue).toHaveBeenCalled();
	});
});
