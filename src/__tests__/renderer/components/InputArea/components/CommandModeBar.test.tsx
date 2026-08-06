import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CommandModeBar } from '../../../../../renderer/components/InputArea/components/CommandModeBar';
import { inputAreaTheme } from '../_fixtures';

describe('CommandModeBar', () => {
	it('names the mode and where the command will run', () => {
		render(<CommandModeBar theme={inputAreaTheme} cwd="/Users/test/project" />);

		expect(screen.getByText('Command Mode')).toBeInTheDocument();
		expect(screen.getByText(/project/)).toBeInTheDocument();
	});

	it('advertises Tab completion, including branches in a git repo', () => {
		render(<CommandModeBar theme={inputAreaTheme} cwd="/repo" isGitRepo />);

		expect(screen.getByText('Tab')).toBeInTheDocument();
		expect(screen.getByText(/files, dirs, branches/)).toBeInTheDocument();
	});

	it('omits branches when the agent is not in a git repo', () => {
		render(<CommandModeBar theme={inputAreaTheme} cwd="/repo" isGitRepo={false} />);

		expect(screen.getByText(/files and dirs/)).toBeInTheDocument();
		expect(screen.queryByText(/branches/)).not.toBeInTheDocument();
	});

	it('shows the SSH remote when the agent runs remotely', () => {
		render(<CommandModeBar theme={inputAreaTheme} cwd="/srv/app" remoteName="builder" />);

		expect(screen.getByText(/builder:/)).toBeInTheDocument();
	});
});
