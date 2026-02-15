/**
 * @file AccountSwitchModal.test.ts
 * @description Tests for AccountSwitchModal component exports and types
 */

import { describe, it, expect } from 'vitest';

describe('AccountSwitchModal', () => {
	it('should export the component', async () => {
		const mod = await import('../../../renderer/components/AccountSwitchModal');
		expect(mod.AccountSwitchModal).toBeDefined();
		expect(typeof mod.AccountSwitchModal).toBe('function');
	});

	it('should return null when isOpen is false', async () => {
		const mod = await import('../../../renderer/components/AccountSwitchModal');
		const result = mod.AccountSwitchModal({
			theme: {
				id: 'dracula',
				name: 'Dracula',
				mode: 'dark',
				colors: {
					bgMain: '#282a36',
					bgSidebar: '#21222c',
					bgActivity: '#44475a',
					border: '#6272a4',
					textMain: '#f8f8f2',
					textDim: '#6272a4',
					accent: '#bd93f9',
					accentDim: '#bd93f920',
					accentText: '#bd93f9',
					accentForeground: '#ffffff',
					success: '#50fa7b',
					warning: '#f1fa8c',
					error: '#ff5555',
				},
			},
			isOpen: false,
			onClose: () => {},
			switchData: {
				sessionId: 'test',
				fromAccountId: 'a1',
				fromAccountName: 'Account 1',
				toAccountId: 'a2',
				toAccountName: 'Account 2',
				reason: 'throttled',
			},
			onConfirmSwitch: () => {},
			onViewDashboard: () => {},
		});
		expect(result).toBeNull();
	});
});
