import React, { useState, useRef, useMemo } from 'react';
import { X } from 'lucide-react';
import type { Theme, Shortcut } from '../types';
import { fuzzyMatch } from '../utils/search';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { FIXED_SHORTCUTS } from '../constants/shortcuts';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { Modal } from './ui/Modal';

interface ShortcutsHelpModalProps {
  theme: Theme;
  shortcuts: Record<string, Shortcut>;
  tabShortcuts: Record<string, Shortcut>;
  onClose: () => void;
  hasNoAgents?: boolean;
}

export function ShortcutsHelpModal({ theme, shortcuts, tabShortcuts, onClose, hasNoAgents }: ShortcutsHelpModalProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Combine all shortcuts for display: editable + tab + fixed (non-editable)
  const allShortcuts = useMemo(() => ({
    ...shortcuts,
    ...tabShortcuts,
    ...FIXED_SHORTCUTS,
  }), [shortcuts, tabShortcuts]);

  const totalShortcuts = Object.values(allShortcuts).length;
  const filteredShortcuts = Object.values(allShortcuts)
    .filter(sc =>
      fuzzyMatch(sc.label, searchQuery) ||
      fuzzyMatch(sc.keys.join(' '), searchQuery)
    )
    .sort((a, b) => a.label.localeCompare(b.label));
  const filteredCount = filteredShortcuts.length;

  // Custom header with title, badge, search input, and close button
  const customHeader = (
    <div className="p-4 border-b" style={{ borderColor: theme.colors.border }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>Keyboard Shortcuts</h2>
          <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}>
            {searchQuery ? `${filteredCount} / ${totalShortcuts}` : totalShortcuts}
          </span>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-white/10 transition-colors" style={{ color: theme.colors.textDim }}>
          <X className="w-4 h-4" />
        </button>
      </div>
      {hasNoAgents && (
        <p className="text-xs mb-3 px-2 py-1.5 rounded" style={{ backgroundColor: theme.colors.accent + '20', color: theme.colors.accent }}>
          Note: Most functionality is unavailable until you've created your first agent.
        </p>
      )}
      <input
        ref={searchInputRef}
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Search shortcuts..."
        className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm"
        style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
      />
    </div>
  );

  // Footer with info text
  const footer = (
    <p className="text-xs w-full text-left" style={{ color: theme.colors.textDim }}>
      Many shortcuts can be customized from Settings → Shortcuts.
    </p>
  );

  return (
    <Modal
      theme={theme}
      title="Keyboard Shortcuts"
      priority={MODAL_PRIORITIES.SHORTCUTS_HELP}
      onClose={onClose}
      customHeader={customHeader}
      footer={footer}
      initialFocusRef={searchInputRef}
    >
      <div className="space-y-2 max-h-[400px] overflow-y-auto scrollbar-thin -my-2">
        {filteredShortcuts.map((sc, i) => (
          <div key={i} className="flex justify-between items-center text-sm">
            <span style={{ color: theme.colors.textDim }}>{sc.label}</span>
            <kbd className="px-2 py-1 rounded border font-mono text-xs font-bold" style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border, color: theme.colors.textMain }}>
              {formatShortcutKeys(sc.keys)}
            </kbd>
          </div>
        ))}
        {filteredCount === 0 && (
          <div className="text-center text-sm opacity-50" style={{ color: theme.colors.textDim }}>
            No shortcuts found
          </div>
        )}
      </div>
    </Modal>
  );
}
