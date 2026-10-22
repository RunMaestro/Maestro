import { ipcRenderer } from 'electron';
import type { GroupAppearance, GroupUpdateRequest } from '../../../shared/groupAppearance';
import type {
	GroupSettingsUpdateRequest,
	GroupSettingsUpdateResult,
} from '../../../shared/groupSettingsUpdate';

export function createGroupCrudRemoteApi() {
	return {
		/**
		 * Subscribe to remote create group from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteCreateGroup: (
			callback: (
				name: string,
				emoji: string | undefined,
				parentGroupId: string | undefined,
				appearance: GroupAppearance,
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				name: string,
				emoji: string | undefined,
				parentGroupId: string | undefined,
				appearance: GroupAppearance,
				responseChannel: string
			) => {
				callback(name, emoji, parentGroupId, appearance ?? {}, responseChannel);
			};
			ipcRenderer.on('remote:createGroup', handler);
			return () => ipcRenderer.removeListener('remote:createGroup', handler);
		},

		/**
		 * Send response for remote create group
		 */
		sendRemoteCreateGroupResponse: (
			responseChannel: string,
			result: { id: string } | null
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote rename group from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteRenameGroup: (
			callback: (groupId: string, name: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, groupId: string, name: string, responseChannel: string) =>
				callback(groupId, name, responseChannel);
			ipcRenderer.on('remote:renameGroup', handler);
			return () => ipcRenderer.removeListener('remote:renameGroup', handler);
		},

		/**
		 * Send response for remote rename group
		 */
		sendRemoteRenameGroupResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote group updates (name / appearance / parent).
		 * Uses request-response pattern with a unique responseChannel.
		 */
		onRemoteUpdateGroup: (
			callback: (groupId: string, update: GroupUpdateRequest, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				groupId: string,
				update: GroupUpdateRequest,
				responseChannel: string
			) => callback(groupId, update, responseChannel);
			ipcRenderer.on('remote:updateGroup', handler);
			return () => ipcRenderer.removeListener('remote:updateGroup', handler);
		},

		/**
		 * Send response for remote update group
		 */
		sendRemoteUpdateGroupResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote writes of a group's Group Settings profile and pill
		 * label. Uses request-response pattern with a unique responseChannel; the
		 * reply is the stored profile and, for a publish, what it reached.
		 */
		onRemoteUpdateGroupSettings: (
			callback: (
				groupId: string,
				request: GroupSettingsUpdateRequest,
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				groupId: string,
				request: GroupSettingsUpdateRequest,
				responseChannel: string
			) => callback(groupId, request, responseChannel);
			ipcRenderer.on('remote:updateGroupSettings', handler);
			return () => ipcRenderer.removeListener('remote:updateGroupSettings', handler);
		},

		/**
		 * Send response for remote update group settings
		 */
		sendRemoteUpdateGroupSettingsResponse: (
			responseChannel: string,
			result: GroupSettingsUpdateResult
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote delete group from web interface (fire-and-forget)
		 */
		onRemoteDeleteGroup: (callback: (groupId: string) => void): (() => void) => {
			const handler = (_: unknown, groupId: string) => callback(groupId);
			ipcRenderer.on('remote:deleteGroup', handler);
			return () => ipcRenderer.removeListener('remote:deleteGroup', handler);
		},

		/**
		 * Subscribe to remote move session to group from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteMoveSessionToGroup: (
			callback: (sessionId: string, groupId: string | null, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				groupId: string | null,
				responseChannel: string
			) => callback(sessionId, groupId, responseChannel);
			ipcRenderer.on('remote:moveSessionToGroup', handler);
			return () => ipcRenderer.removeListener('remote:moveSessionToGroup', handler);
		},

		/**
		 * Send response for remote move session to group
		 */
		sendRemoteMoveSessionToGroupResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},
	};
}
