import { settleRetiredWorktreeWatchers } from './worktreeWatch';
import { markDesktopOnlyChannel } from '../../desktop-only-channels';
import { withErrorLogging } from '../../../utils/ipcHandler';
import { handlerOpts } from './shared';
import { BrowserWindow, ipcMain } from 'electron';
import { worktreeRetirement } from '../../../git/worktreeRetirement';
import {
	WorktreeRetirementHost,
	type RetirementRenderer,
} from '../../../git/worktreeRetirementHost';
import { requestFromRenderer } from '../../../web-server/callbacks/remoteRequest';
import type { RetirementRendererReply } from '../../../../shared/worktreeRetirement';

/** Desktop only: Main verifies the actual sender against the loaded primary. */
export function registerRetirementHandlers(): void {
	const host = new WorktreeRetirementHost(
		worktreeRetirement,
		undefined,
		settleRetiredWorktreeWatchers
	);
	for (const channel of [
		'git:prepareWorktreeRetirement',
		'git:abortWorktreeRetirement',
		'git:getWorktreeRetirementRecoveries',
		'git:cancelWorktreeRetirementRecovery',
		'git:retirementRendererRequest',
		'git:retirementRendererRelease',
	])
		markDesktopOnlyChannel(channel);
	ipcMain.handle(
		'git:getWorktreeRetirementRecoveries',
		withErrorLogging(handlerOpts('getWorktreeRetirementRecoveries'), async (event) => {
			if (
				!BrowserWindow.fromWebContents(event.sender) ||
				event.senderFrame !== event.sender.mainFrame
			)
				throw new Error('desktop main frame required');
			return worktreeRetirement.pendingRecoveries();
		})
	);
	ipcMain.handle(
		'git:cancelWorktreeRetirementRecovery',
		withErrorLogging(
			handlerOpts('cancelWorktreeRetirementRecovery'),
			async (event: Electron.IpcMainInvokeEvent, id: string) => {
				if (
					!BrowserWindow.fromWebContents(event.sender) ||
					event.senderFrame !== event.sender.mainFrame ||
					typeof id !== 'string' ||
					!id
				)
					return { ok: false, reason: 'desktop main frame and recovery id required' };
				return worktreeRetirement.cancelRecoveredRemoval(id, event.sender);
			}
		)
	);
	ipcMain.handle(
		'git:prepareWorktreeRetirement',
		withErrorLogging(
			handlerOpts('prepareWorktreeRetirement'),
			async (event: Electron.IpcMainInvokeEvent, sessionId: string) => {
				const win = BrowserWindow.fromWebContents(event.sender);
				if (!win || event.senderFrame !== event.sender.mainFrame)
					return { ok: false, reason: 'primary desktop window required' };
				const sender = event.sender;
				const renderer: RetirementRenderer = {
					identity: sender,
					request: (command) =>
						requestFromRenderer<RetirementRendererReply>(win, 'git:retirementRendererRequest', {
							fallback: { ok: false, reason: 'renderer preparation timed out' },
							args: [command],
						}),
					release: (sessionId, token) =>
						sender.send('git:retirementRendererRelease', sessionId, token),
					onInvalidated: (callback) => {
						const navigation = (
							_event: unknown,
							_url: string,
							_inPlace: boolean,
							isMainFrame: boolean
						) => {
							if (isMainFrame) callback();
						};
						sender.on('did-start-navigation', navigation);
						sender.on('render-process-gone', callback);
						sender.on('destroyed', callback);
						return () => {
							sender.removeListener('did-start-navigation', navigation);
							sender.removeListener('render-process-gone', callback);
							sender.removeListener('destroyed', callback);
						};
					},
				};
				return host.prepare(sessionId, renderer);
			}
		)
	);
	ipcMain.handle(
		'git:abortWorktreeRetirement',
		withErrorLogging(
			handlerOpts('abortWorktreeRetirement'),
			async (event: Electron.IpcMainInvokeEvent, token: string) =>
				event.senderFrame === event.sender.mainFrame && host.abort(token, event.sender)
		)
	);
}
