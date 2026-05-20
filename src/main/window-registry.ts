import { BrowserWindow } from 'electron';
import type { BrowserWindowConstructorOptions } from 'electron';

export interface WindowRegistryEntry {
	browserWindow: BrowserWindow;
	sessionIds: string[];
	isMain: boolean;
}

export interface WindowRegistryCreateOptions extends BrowserWindowConstructorOptions {
	id?: string;
	sessionIds?: string[];
	isMain?: boolean;
}

export class WindowRegistry {
	private windows = new Map<string, WindowRegistryEntry>();
	private primaryWindowId: string | null = null;

	create(options: WindowRegistryCreateOptions = {}): WindowRegistryEntry {
		const { id, sessionIds = [], isMain, ...browserWindowOptions } = options;
		const browserWindow = new BrowserWindow(browserWindowOptions);
		const windowId = id ?? String(browserWindow.id);
		const shouldBeMain = isMain ?? this.primaryWindowId === null;

		if (this.windows.has(windowId)) {
			throw new Error(`Window already registered: ${windowId}`);
		}
		if (shouldBeMain && this.primaryWindowId !== null) {
			throw new Error(`Primary window already registered: ${this.primaryWindowId}`);
		}

		const entry: WindowRegistryEntry = {
			browserWindow,
			sessionIds: [],
			isMain: shouldBeMain,
		};

		this.windows.set(windowId, entry);
		if (shouldBeMain) {
			this.primaryWindowId = windowId;
		}
		this.setSessionsForWindow(windowId, sessionIds);

		return entry;
	}

	get(windowId: string): WindowRegistryEntry | undefined {
		return this.windows.get(windowId);
	}

	getAll(): WindowRegistryEntry[] {
		return Array.from(this.windows.values());
	}

	getPrimary(): WindowRegistryEntry | undefined {
		return this.primaryWindowId ? this.windows.get(this.primaryWindowId) : undefined;
	}

	remove(windowId: string): void {
		const entry = this.windows.get(windowId);
		if (!entry) {
			return;
		}

		this.windows.delete(windowId);
		if (entry.isMain) {
			this.primaryWindowId = null;
		}
	}

	getWindowForSession(sessionId: string): string | undefined {
		for (const [windowId, entry] of this.windows) {
			if (entry.sessionIds.includes(sessionId)) {
				return windowId;
			}
		}

		return undefined;
	}

	setSessionsForWindow(windowId: string, sessionIds: string[]): void {
		const entry = this.windows.get(windowId);
		if (!entry) {
			throw new Error(`Window not registered: ${windowId}`);
		}

		const uniqueSessionIds = Array.from(new Set(sessionIds));
		for (const [otherWindowId, otherEntry] of this.windows) {
			if (otherWindowId === windowId) {
				continue;
			}
			otherEntry.sessionIds = otherEntry.sessionIds.filter(
				(sessionId) => !uniqueSessionIds.includes(sessionId)
			);
		}

		entry.sessionIds = uniqueSessionIds;
	}

	moveSession(sessionId: string, fromWindowId: string, toWindowId: string): void {
		const fromWindow = this.windows.get(fromWindowId);
		const toWindow = this.windows.get(toWindowId);
		if (!fromWindow) {
			throw new Error(`Source window not registered: ${fromWindowId}`);
		}
		if (!toWindow) {
			throw new Error(`Destination window not registered: ${toWindowId}`);
		}

		fromWindow.sessionIds = fromWindow.sessionIds.filter((id) => id !== sessionId);
		for (const [windowId, entry] of this.windows) {
			if (windowId === toWindowId || windowId === fromWindowId) {
				continue;
			}
			entry.sessionIds = entry.sessionIds.filter((id) => id !== sessionId);
		}

		if (!toWindow.sessionIds.includes(sessionId)) {
			toWindow.sessionIds.push(sessionId);
		}
	}
}
