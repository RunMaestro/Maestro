import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { PermissionPrompt } from '../../../../renderer/components/PermissionPrompt/PermissionPrompt';
import {
	usePermissionRequestStore,
	type PermissionRequestUI,
} from '../../../../renderer/stores/permissionRequestStore';
import { mockTheme } from '../../../helpers/mockTheme';
import type { PendingPermissionSnapshot } from '../../../../shared/pendingPermissions';

vi.mock('../../../../renderer/hooks/ui/useModalLayer', () => ({ useModalLayer: vi.fn() }));
let restoreBridge = () => {};
afterEach(() => {
	restoreBridge();
	cleanup();
	usePermissionRequestStore.setState({ queue: [] });
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it('removes a host-answered question, retains an open permission and ignores older snapshots without sending decisions', () => {
	let request!: (r: PermissionRequestUI) => void;
	let pending!: (s: PendingPermissionSnapshot) => void;
	const respond = vi.fn(async () => true);
	const original = { ...window.maestro.process };
	restoreBridge = () => {
		for (const key of [
			'respondPermission',
			'onPermissionRequest',
			'onPendingPermissionsChanged',
		] as const) {
			if (!(key in original))
				delete (window.maestro.process as unknown as Record<string, unknown>)[key];
		}
		Object.assign(window.maestro.process, original);
	};
	Object.assign(window.maestro.process, {
		respondPermission: respond,
		onPermissionRequest: (cb: typeof request) => {
			request = cb;
			return vi.fn();
		},
		onPendingPermissionsChanged: (cb: typeof pending) => {
			pending = cb;
			return vi.fn();
		},
	});
	render(<PermissionPrompt theme={mockTheme} />);
	act(() => {
		request({
			requestId: 'question',
			sessionId: 'agent-ai-tab',
			toolName: 'AskUserQuestion',
			input: {},
			createdAt: 1,
			kind: 'question',
			questions: [
				{ question: 'Name the variable?', options: [{ label: 'count' }], multiSelect: false },
			],
		});
		request({
			requestId: 'tool',
			sessionId: 'agent-ai-tab',
			toolName: 'Bash',
			input: { command: 'run protected command' },
			createdAt: 2,
		});
	});
	expect(screen.getByText('Name the variable?')).toBeTruthy();
	act(() => pending({ version: 2, processIds: ['agent-ai-tab'], requestIds: ['tool'] }));
	expect(screen.queryByText('Name the variable?')).toBeNull();
	expect(screen.getByText('run protected command')).toBeTruthy();
	act(() => pending({ version: 1, processIds: [], requestIds: [] }));
	expect(screen.getByText('run protected command')).toBeTruthy();
	expect(respond).not.toHaveBeenCalled();
	act(() => pending({ version: 3, processIds: [], requestIds: [] }));
	expect(screen.queryByText('run protected command')).toBeNull();
	expect(respond).not.toHaveBeenCalled();
});
