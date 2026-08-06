/**
 * Tests for ShellCommandCard - the transcript card for a command-mode
 * (`!command`) run.
 *
 * Driven entirely by the anchoring LogEntry, so the tests build entries in each
 * state (running, exit 0, non-zero exit, stopped, truncated) and assert what the
 * card shows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Convert from 'ansi-to-html';
import { ShellCommandCard } from '../../../renderer/components/ShellCommandCard';
import { mockTheme } from '../../helpers/mockTheme';
import type { LogEntry } from '../../../renderer/types';

const cancelShellCommand = vi.fn().mockResolvedValue(true);
vi.mock('../../../renderer/services/shellCommand', () => ({
	cancelShellCommand: (id: string) => cancelShellCommand(id),
}));

const converter = new Convert();

function makeLog(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		id: 'log-1',
		timestamp: 0,
		source: 'stdout',
		text: '',
		shellCommand: {
			command: 'git status',
			cwd: '/repo',
			status: 'running',
			...(overrides.shellCommand ?? {}),
		},
		...overrides,
	};
}

function renderCard(log: LogEntry) {
	return render(
		<ShellCommandCard
			log={log}
			theme={mockTheme}
			fontFamily="monospace"
			ansiConverter={converter}
		/>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('ShellCommandCard', () => {
	it('renders nothing for an entry without a shellCommand record', () => {
		const { container } = renderCard({
			id: 'x',
			timestamp: 0,
			source: 'stdout',
			text: 'hi',
		});
		expect(container.firstChild).toBeNull();
	});

	it('shows the command and a Stop button while running', () => {
		renderCard(makeLog());

		expect(screen.getByText('git status')).toBeTruthy();
		expect(screen.getByText('Stop')).toBeTruthy();
		expect(screen.getByText('Running...')).toBeTruthy();
	});

	it('stops the run when Stop is clicked', () => {
		renderCard(makeLog());

		fireEvent.click(screen.getByText('Stop'));

		expect(cancelShellCommand).toHaveBeenCalledWith('log-1');
	});

	it('renders output as terminal text', () => {
		const { container } = renderCard(makeLog({ text: 'M  src/app.ts\n?? notes.md\n' }));

		expect(container.textContent).toContain('M  src/app.ts');
		expect(container.textContent).toContain('?? notes.md');
	});

	it('shows the exit code and duration once finished', () => {
		renderCard(
			makeLog({
				text: 'done\n',
				shellCommand: {
					command: 'git status',
					cwd: '/repo',
					status: 'finished',
					exitCode: 0,
					durationMs: 1500,
				},
			})
		);

		expect(screen.getByText(/exit 0/)).toBeTruthy();
		expect(screen.queryByText('Stop')).toBeNull();
	});

	it('shows a non-zero exit code', () => {
		renderCard(
			makeLog({
				text: 'command not found\n',
				shellCommand: {
					command: 'nope',
					cwd: '/repo',
					status: 'finished',
					exitCode: 127,
				},
			})
		);

		expect(screen.getByText(/exit 127/)).toBeTruthy();
	});

	it('shows a stopped run as stopped, not as an exit code', () => {
		renderCard(
			makeLog({
				text: 'partial\n',
				shellCommand: {
					command: 'tail -f log',
					cwd: '/repo',
					status: 'cancelled',
					exitCode: 143,
				},
			})
		);

		expect(screen.getByText('stopped')).toBeTruthy();
		expect(screen.queryByText(/exit 143/)).toBeNull();
	});

	it('notes truncated output', () => {
		renderCard(
			makeLog({
				text: 'lots of output',
				shellCommand: {
					command: 'yes',
					cwd: '/repo',
					status: 'finished',
					exitCode: 0,
					truncated: true,
				},
			})
		);

		expect(screen.getByText(/Output truncated/)).toBeTruthy();
	});

	it('shows the SSH remote name when the agent runs remotely', () => {
		renderCard(
			makeLog({
				shellCommand: {
					command: 'uname -a',
					cwd: '/srv/app',
					remoteName: 'builder',
					status: 'running',
				},
			})
		);

		expect(screen.getByText(/builder:/)).toBeTruthy();
	});

	it('reports no output for a command that printed nothing', () => {
		renderCard(
			makeLog({
				shellCommand: {
					command: 'true',
					cwd: '/repo',
					status: 'finished',
					exitCode: 0,
				},
			})
		);

		expect(screen.getByText('No output')).toBeTruthy();
	});
});
