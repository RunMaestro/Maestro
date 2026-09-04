import { useCommandKeyShortcut } from './useCommandKeyShortcut';

/**
 * Listens for Cmd+S (macOS) / Ctrl+S (other) and invokes `handler` while `enabled` is true.
 * Thin preset over `useCommandKeyShortcut`, which owns the capture-phase +
 * preventDefault behaviour so this wins against textarea/input handlers and the
 * browser's default "Save Page As".
 */
export function useSaveShortcut(handler: () => void, enabled: boolean): void {
	useCommandKeyShortcut('s', handler, enabled);
}
