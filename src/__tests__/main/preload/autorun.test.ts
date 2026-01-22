/**
 * Tests for autorun preload API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import {
	createAutorunApi,
	createPlaybooksApi,
	createMarketplaceApi,
} from '../../../main/preload/autorun';

describe('Autorun Preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('createAutorunApi', () => {
		let api: ReturnType<typeof createAutorunApi>;

		beforeEach(() => {
			api = createAutorunApi();
		});

		describe('listDocs', () => {
			it('should invoke autorun:listDocs', async () => {
				mockInvoke.mockResolvedValue(['doc1.md', 'doc2.md']);

				const result = await api.listDocs('/project/.maestro');

				expect(mockInvoke).toHaveBeenCalledWith('autorun:listDocs', '/project/.maestro', undefined);
				expect(result).toEqual(['doc1.md', 'doc2.md']);
			});

			it('should invoke with sshRemoteId', async () => {
				mockInvoke.mockResolvedValue([]);

				await api.listDocs('/project/.maestro', 'ssh-remote-1');

				expect(mockInvoke).toHaveBeenCalledWith(
					'autorun:listDocs',
					'/project/.maestro',
					'ssh-remote-1'
				);
			});
		});

		describe('hasDocuments', () => {
			it('should invoke autorun:hasDocuments', async () => {
				mockInvoke.mockResolvedValue({ hasDocuments: true });

				const result = await api.hasDocuments('/project');

				expect(mockInvoke).toHaveBeenCalledWith('autorun:hasDocuments', '/project');
				expect(result.hasDocuments).toBe(true);
			});
		});

		describe('readDoc', () => {
			it('should invoke autorun:readDoc', async () => {
				mockInvoke.mockResolvedValue('# Document Content');

				const result = await api.readDoc('/project/.maestro', 'tasks.md');

				expect(mockInvoke).toHaveBeenCalledWith(
					'autorun:readDoc',
					'/project/.maestro',
					'tasks.md',
					undefined
				);
				expect(result).toBe('# Document Content');
			});
		});

		describe('writeDoc', () => {
			it('should invoke autorun:writeDoc', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.writeDoc('/project/.maestro', 'tasks.md', '# New Content');

				expect(mockInvoke).toHaveBeenCalledWith(
					'autorun:writeDoc',
					'/project/.maestro',
					'tasks.md',
					'# New Content',
					undefined
				);
			});
		});

		describe('saveImage', () => {
			it('should invoke autorun:saveImage', async () => {
				mockInvoke.mockResolvedValue({ path: 'image.png' });

				await api.saveImage('/project/.maestro', 'doc1', 'base64data', 'png');

				expect(mockInvoke).toHaveBeenCalledWith(
					'autorun:saveImage',
					'/project/.maestro',
					'doc1',
					'base64data',
					'png'
				);
			});
		});

		describe('deleteImage', () => {
			it('should invoke autorun:deleteImage', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.deleteImage('/project/.maestro', 'images/image.png');

				expect(mockInvoke).toHaveBeenCalledWith(
					'autorun:deleteImage',
					'/project/.maestro',
					'images/image.png'
				);
			});
		});

		describe('listImages', () => {
			it('should invoke autorun:listImages', async () => {
				mockInvoke.mockResolvedValue(['image1.png', 'image2.jpg']);

				const result = await api.listImages('/project/.maestro', 'doc1');

				expect(mockInvoke).toHaveBeenCalledWith('autorun:listImages', '/project/.maestro', 'doc1');
				expect(result).toEqual(['image1.png', 'image2.jpg']);
			});
		});

		describe('deleteFolder', () => {
			it('should invoke autorun:deleteFolder', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.deleteFolder('/project');

				expect(mockInvoke).toHaveBeenCalledWith('autorun:deleteFolder', '/project');
			});
		});

		describe('watchFolder', () => {
			it('should invoke autorun:watchFolder', async () => {
				mockInvoke.mockResolvedValue({});

				await api.watchFolder('/project/.maestro');

				expect(mockInvoke).toHaveBeenCalledWith(
					'autorun:watchFolder',
					'/project/.maestro',
					undefined
				);
			});

			it('should handle remote folder', async () => {
				mockInvoke.mockResolvedValue({
					isRemote: true,
					message: 'File watching not available for remote',
				});

				const result = await api.watchFolder('/project/.maestro', 'ssh-remote-1');

				expect(result.isRemote).toBe(true);
			});
		});

		describe('unwatchFolder', () => {
			it('should invoke autorun:unwatchFolder', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.unwatchFolder('/project/.maestro');

				expect(mockInvoke).toHaveBeenCalledWith('autorun:unwatchFolder', '/project/.maestro');
			});
		});

		describe('onFileChanged', () => {
			it('should register event listener and return cleanup function', () => {
				const callback = vi.fn();

				const cleanup = api.onFileChanged(callback);

				expect(mockOn).toHaveBeenCalledWith('autorun:fileChanged', expect.any(Function));
				expect(typeof cleanup).toBe('function');
			});

			it('should call callback when event is received', () => {
				const callback = vi.fn();
				let registeredHandler: (event: unknown, data: unknown) => void;

				mockOn.mockImplementation(
					(_channel: string, handler: (event: unknown, data: unknown) => void) => {
						registeredHandler = handler;
					}
				);

				api.onFileChanged(callback);

				const data = { folderPath: '/project', filename: 'tasks.md', eventType: 'change' };
				registeredHandler!({}, data);

				expect(callback).toHaveBeenCalledWith(data);
			});
		});

		describe('createBackup', () => {
			it('should invoke autorun:createBackup', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.createBackup('/project/.maestro', 'tasks.md');

				expect(mockInvoke).toHaveBeenCalledWith(
					'autorun:createBackup',
					'/project/.maestro',
					'tasks.md'
				);
			});
		});

		describe('restoreBackup', () => {
			it('should invoke autorun:restoreBackup', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.restoreBackup('/project/.maestro', 'tasks.md');

				expect(mockInvoke).toHaveBeenCalledWith(
					'autorun:restoreBackup',
					'/project/.maestro',
					'tasks.md'
				);
			});
		});

		describe('deleteBackups', () => {
			it('should invoke autorun:deleteBackups', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.deleteBackups('/project/.maestro');

				expect(mockInvoke).toHaveBeenCalledWith('autorun:deleteBackups', '/project/.maestro');
			});
		});

		describe('createWorkingCopy', () => {
			it('should invoke autorun:createWorkingCopy', async () => {
				mockInvoke.mockResolvedValue({
					workingCopyPath: '/project/.maestro/tasks.loop-1.md',
					originalPath: '/project/.maestro/tasks.md',
				});

				const result = await api.createWorkingCopy('/project/.maestro', 'tasks.md', 1);

				expect(mockInvoke).toHaveBeenCalledWith(
					'autorun:createWorkingCopy',
					'/project/.maestro',
					'tasks.md',
					1
				);
				expect(result.workingCopyPath).toContain('loop-1');
			});
		});
	});

	describe('createPlaybooksApi', () => {
		let api: ReturnType<typeof createPlaybooksApi>;

		beforeEach(() => {
			api = createPlaybooksApi();
		});

		describe('list', () => {
			it('should invoke playbooks:list', async () => {
				mockInvoke.mockResolvedValue([{ id: 'pb-1', name: 'Playbook 1' }]);

				const result = await api.list('session-123');

				expect(mockInvoke).toHaveBeenCalledWith('playbooks:list', 'session-123');
				expect(result).toEqual([{ id: 'pb-1', name: 'Playbook 1' }]);
			});
		});

		describe('create', () => {
			it('should invoke playbooks:create', async () => {
				const playbook = {
					name: 'New Playbook',
					documents: [{ filename: 'tasks.md', resetOnCompletion: false }],
					loopEnabled: false,
					prompt: 'Run these tasks',
				};
				mockInvoke.mockResolvedValue({ id: 'pb-new' });

				await api.create('session-123', playbook);

				expect(mockInvoke).toHaveBeenCalledWith('playbooks:create', 'session-123', playbook);
			});
		});

		describe('update', () => {
			it('should invoke playbooks:update', async () => {
				const updates = { name: 'Updated Name' };
				mockInvoke.mockResolvedValue({ success: true });

				await api.update('session-123', 'pb-1', updates);

				expect(mockInvoke).toHaveBeenCalledWith('playbooks:update', 'session-123', 'pb-1', updates);
			});
		});

		describe('delete', () => {
			it('should invoke playbooks:delete', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.delete('session-123', 'pb-1');

				expect(mockInvoke).toHaveBeenCalledWith('playbooks:delete', 'session-123', 'pb-1');
			});
		});

		describe('deleteAll', () => {
			it('should invoke playbooks:deleteAll', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.deleteAll('session-123');

				expect(mockInvoke).toHaveBeenCalledWith('playbooks:deleteAll', 'session-123');
			});
		});

		describe('export', () => {
			it('should invoke playbooks:export', async () => {
				mockInvoke.mockResolvedValue({ success: true, path: '/export/playbook.zip' });

				await api.export('session-123', 'pb-1', '/project/.maestro');

				expect(mockInvoke).toHaveBeenCalledWith(
					'playbooks:export',
					'session-123',
					'pb-1',
					'/project/.maestro'
				);
			});
		});

		describe('import', () => {
			it('should invoke playbooks:import', async () => {
				mockInvoke.mockResolvedValue({ success: true, playbookId: 'pb-imported' });

				await api.import('session-123', '/project/.maestro');

				expect(mockInvoke).toHaveBeenCalledWith(
					'playbooks:import',
					'session-123',
					'/project/.maestro'
				);
			});
		});
	});

	describe('createMarketplaceApi', () => {
		let api: ReturnType<typeof createMarketplaceApi>;

		beforeEach(() => {
			api = createMarketplaceApi();
		});

		describe('getManifest', () => {
			it('should invoke marketplace:getManifest', async () => {
				const manifest = { playbooks: [{ id: 'mp-1', name: 'Marketplace Playbook' }] };
				mockInvoke.mockResolvedValue(manifest);

				const result = await api.getManifest();

				expect(mockInvoke).toHaveBeenCalledWith('marketplace:getManifest');
				expect(result).toEqual(manifest);
			});
		});

		describe('refreshManifest', () => {
			it('should invoke marketplace:refreshManifest', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.refreshManifest();

				expect(mockInvoke).toHaveBeenCalledWith('marketplace:refreshManifest');
			});
		});

		describe('getDocument', () => {
			it('should invoke marketplace:getDocument', async () => {
				mockInvoke.mockResolvedValue('# Document content');

				const result = await api.getDocument('playbooks/example', 'tasks.md');

				expect(mockInvoke).toHaveBeenCalledWith(
					'marketplace:getDocument',
					'playbooks/example',
					'tasks.md'
				);
				expect(result).toBe('# Document content');
			});
		});

		describe('getReadme', () => {
			it('should invoke marketplace:getReadme', async () => {
				mockInvoke.mockResolvedValue('# README');

				const result = await api.getReadme('playbooks/example');

				expect(mockInvoke).toHaveBeenCalledWith('marketplace:getReadme', 'playbooks/example');
				expect(result).toBe('# README');
			});
		});

		describe('importPlaybook', () => {
			it('should invoke marketplace:importPlaybook', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.importPlaybook('mp-1', 'my-playbook', '/project/.maestro', 'session-123');

				expect(mockInvoke).toHaveBeenCalledWith(
					'marketplace:importPlaybook',
					'mp-1',
					'my-playbook',
					'/project/.maestro',
					'session-123',
					undefined
				);
			});

			it('should invoke with sshRemoteId', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.importPlaybook(
					'mp-1',
					'my-playbook',
					'/project/.maestro',
					'session-123',
					'ssh-remote-1'
				);

				expect(mockInvoke).toHaveBeenCalledWith(
					'marketplace:importPlaybook',
					'mp-1',
					'my-playbook',
					'/project/.maestro',
					'session-123',
					'ssh-remote-1'
				);
			});
		});

		describe('onManifestChanged', () => {
			it('should register event listener and return cleanup function', () => {
				const callback = vi.fn();

				const cleanup = api.onManifestChanged(callback);

				expect(mockOn).toHaveBeenCalledWith('marketplace:manifestChanged', expect.any(Function));
				expect(typeof cleanup).toBe('function');
			});

			it('should call callback when event is received', () => {
				const callback = vi.fn();
				let registeredHandler: () => void;

				mockOn.mockImplementation((_channel: string, handler: () => void) => {
					registeredHandler = handler;
				});

				api.onManifestChanged(callback);
				registeredHandler!();

				expect(callback).toHaveBeenCalled();
			});
		});
	});
});
