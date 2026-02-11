export interface NotificationMetadata {
	/** Maestro session ID associated with this notification */
	sessionId?: string;
	/** Specific tab ID if this notification targets a particular tab */
	tabId?: string;
	/** Window ID that owns the referenced session/tab */
	windowId?: string | null;
}
