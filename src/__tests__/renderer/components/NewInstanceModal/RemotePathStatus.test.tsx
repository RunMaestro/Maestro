/**
 * @fileoverview Tests for RemotePathStatus component
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RemotePathStatus } from '../../../../renderer/components/NewInstanceModal/RemotePathStatus';
import type { Theme } from '../../../../renderer/types';

// lucide-react icons are mocked globally in src/__tests__/setup.ts using a Proxy

const createTheme = (): Theme =>
	({
		id: 'test-dark',
		name: 'Test Dark',
		mode: 'dark',
		colors: {
			bgMain: '#1a1a2e',
			bgSidebar: '#16213e',
			bgActivity: '#0f3460',
			textMain: '#e8e8e8',
			textDim: '#888888',
			accent: '#7b2cbf',
			accentDim: '#5a1f8f',
			accentForeground: '#ffffff',
			border: '#333355',
			success: '#22c55e',
			warning: '#f59e0b',
			error: '#ef4444',
			info: '#3b82f6',
			bgAccentHover: '#9333ea',
		},
	}) as Theme;

describe('RemotePathStatus', () => {
	it('should render nothing when no state to show', () => {
		const { container } = render(
			<RemotePathStatus
				theme={createTheme()}
				validation={{ checking: false, valid: false, isDirectory: false }}
			/>
		);

		expect(container.innerHTML).toBe('');
	});

	it('should show spinner and generic message when checking without remoteHost', () => {
		render(
			<RemotePathStatus
				theme={createTheme()}
				validation={{ checking: true, valid: false, isDirectory: false }}
			/>
		);

		expect(screen.getByText('Checking remote path...')).toBeInTheDocument();
	});

	it('should show spinner with host name when checking with remoteHost', () => {
		render(
			<RemotePathStatus
				theme={createTheme()}
				validation={{ checking: true, valid: false, isDirectory: false }}
				remoteHost="my-server.com"
			/>
		);

		expect(screen.getByText('Checking path on my-server.com...')).toBeInTheDocument();
	});

	it('should show success without host when valid', () => {
		render(
			<RemotePathStatus
				theme={createTheme()}
				validation={{ checking: false, valid: true, isDirectory: true }}
			/>
		);

		expect(screen.getByText('Remote directory found')).toBeInTheDocument();
	});

	it('should show success with host when valid and remoteHost provided', () => {
		render(
			<RemotePathStatus
				theme={createTheme()}
				validation={{ checking: false, valid: true, isDirectory: true }}
				remoteHost="my-server.com"
			/>
		);

		expect(screen.getByText('Directory found on my-server.com')).toBeInTheDocument();
	});

	it('should show error message without host suffix', () => {
		render(
			<RemotePathStatus
				theme={createTheme()}
				validation={{
					checking: false,
					valid: false,
					isDirectory: false,
					error: 'Path is a file, not a directory',
				}}
			/>
		);

		expect(screen.getByText('Path is a file, not a directory')).toBeInTheDocument();
	});

	it('should show error message with host suffix when remoteHost provided', () => {
		render(
			<RemotePathStatus
				theme={createTheme()}
				validation={{
					checking: false,
					valid: false,
					isDirectory: false,
					error: 'Path not found or not accessible',
				}}
				remoteHost="my-server.com"
			/>
		);

		expect(
			screen.getByText('Path not found or not accessible (my-server.com)')
		).toBeInTheDocument();
	});
});
