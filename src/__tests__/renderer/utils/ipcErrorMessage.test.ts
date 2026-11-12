import { describe, expect, it } from 'vitest';
import { ipcErrorMessage, ipcResultErrorMessage } from '../../../renderer/utils/ipcErrorMessage';

describe('ipcErrorMessage', () => {
	it('drops the wrapper Electron puts around a throw from a main-process handler', () => {
		const error = new Error(
			'Error invoking remote method \'webLogin:createUser\': Error: An account named "linus" already exists.'
		);

		expect(ipcErrorMessage(error)).toBe('An account named "linus" already exists.');
	});

	it('drops the class of an error that is not a plain Error', () => {
		const error = new Error(
			"Error invoking remote method 'agents:setConfig': TypeError: An agent id is required."
		);

		expect(ipcErrorMessage(error)).toBe('An agent id is required.');
	});

	it('keeps the whole of what the handler said, colons and all', () => {
		const error = new Error(
			"Error invoking remote method 'fs:readDir': Error: EACCES: permission denied, scandir '/var/log'"
		);

		expect(ipcErrorMessage(error)).toBe("EACCES: permission denied, scandir '/var/log'");
	});

	it('keeps an error inside the message the handler wrote', () => {
		const error = new Error(
			"Error invoking remote method 'git:push': Error: Push failed: Error: remote rejected"
		);

		expect(ipcErrorMessage(error)).toBe('Push failed: Error: remote rejected');
	});

	it('returns a message that was never wrapped as it is', () => {
		expect(ipcErrorMessage(new Error('disk on fire'))).toBe('disk on fire');
		expect(ipcErrorMessage(new Error('Error: written that way'))).toBe('Error: written that way');
	});

	it('shows a value that is not an Error as text', () => {
		expect(ipcErrorMessage('plain text')).toBe('plain text');
		expect(ipcErrorMessage(undefined)).toBe('undefined');
		expect(ipcErrorMessage(new Error(''))).toBe('Error');
	});
});

describe('ipcResultErrorMessage', () => {
	const fallback = 'The launch did not start.';

	it('drops the class name String(error) puts in front of a createIpcHandler error', () => {
		expect(
			ipcResultErrorMessage('MarketplaceImportError: Playbook not found: code-review', fallback)
		).toBe('Playbook not found: code-review');
		expect(ipcResultErrorMessage('Error: disk on fire', fallback)).toBe('disk on fire');
		expect(ipcResultErrorMessage('TypeError: x is not a function', fallback)).toBe(
			'x is not a function'
		);
	});

	it('keeps the whole of what the handler said, colons and all', () => {
		expect(
			ipcResultErrorMessage(
				'MarketplaceLaunchValuesError: Launch values are not valid: PR_URL: This field is required',
				fallback
			)
		).toBe('Launch values are not valid: PR_URL: This field is required');
		expect(ipcResultErrorMessage("Error: EACCES: permission denied, mkdir '/x'", fallback)).toBe(
			"EACCES: permission denied, mkdir '/x'"
		);
	});

	it('returns a thrown string as it is', () => {
		expect(ipcResultErrorMessage('remote rejected the folder', fallback)).toBe(
			'remote rejected the folder'
		);
	});

	it('falls back when there is no error to show', () => {
		expect(ipcResultErrorMessage(undefined, fallback)).toBe(fallback);
		expect(ipcResultErrorMessage('', fallback)).toBe(fallback);
		expect(ipcResultErrorMessage('   ', fallback)).toBe(fallback);
		expect(ipcResultErrorMessage('Error: ', fallback)).toBe(fallback);
	});
});
