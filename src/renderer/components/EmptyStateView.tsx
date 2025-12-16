import React, { useState, useRef, useEffect } from 'react';
import { Wand2, Bot, Menu, Settings, HelpCircle, Info, RefreshCw, Compass } from 'lucide-react';
import type { Theme, Shortcut } from '../types';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { useClickOutside } from '../hooks';

interface EmptyStateViewProps {
  theme: Theme;
  shortcuts: Record<string, Shortcut>;
  onNewAgent: () => void;
  onOpenWizard: () => void;
  onOpenSettings: () => void;
  onOpenShortcutsHelp: () => void;
  onOpenAbout: () => void;
  onCheckForUpdates: () => void;
  onStartTour?: () => void;
}

export function EmptyStateView({
  theme,
  shortcuts,
  onNewAgent,
  onOpenWizard,
  onOpenSettings,
  onOpenShortcutsHelp,
  onOpenAbout,
  onCheckForUpdates,
  onStartTour,
}: EmptyStateViewProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useClickOutside(menuRef, () => setMenuOpen(false), menuOpen);

  // Close menu on Escape
  useEffect(() => {
    const handleEscKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && menuOpen) {
        setMenuOpen(false);
        e.preventDefault();
        e.stopPropagation();
      }
    };
    if (menuOpen) {
      document.addEventListener('keydown', handleEscKey);
      return () => document.removeEventListener('keydown', handleEscKey);
    }
  }, [menuOpen]);

  return (
    <div className="flex-1 flex flex-col" style={{ backgroundColor: theme.colors.bgMain }}>
      {/* Top Bar */}
      <div
        className="h-16 border-b flex items-center justify-between px-4 shrink-0"
        style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
      >
        {/* Left: Logo and Name */}
        <div className="flex items-center gap-2">
          <Wand2 className="w-5 h-5" style={{ color: theme.colors.accent }} />
          <h1 className="font-bold tracking-widest text-lg" style={{ color: theme.colors.textMain }}>
            MAESTRO
          </h1>
        </div>

        {/* Right: Hamburger Menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-2 rounded hover:bg-white/10 transition-colors"
            style={{ color: theme.colors.textDim }}
            title="Menu"
          >
            <Menu className="w-5 h-5" />
          </button>

          {/* Menu Overlay */}
          {menuOpen && (
            <div
              className="absolute top-full right-0 mt-2 w-72 rounded-lg shadow-2xl z-50 overflow-hidden"
              style={{
                backgroundColor: theme.colors.bgSidebar,
                border: `1px solid ${theme.colors.border}`,
              }}
            >
              <div className="p-1">
                <button
                  onClick={() => { onOpenWizard(); setMenuOpen(false); }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
                >
                  <Wand2 className="w-5 h-5" style={{ color: theme.colors.accent }} />
                  <div className="flex-1">
                    <div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>New Agent Wizard</div>
                    <div className="text-xs" style={{ color: theme.colors.textDim }}>Get started with AI</div>
                  </div>
                  <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}>
                    {shortcuts.openWizard ? formatShortcutKeys(shortcuts.openWizard.keys) : '⇧⌘N'}
                  </span>
                </button>

                {onStartTour && (
                  <button
                    onClick={() => { onStartTour(); setMenuOpen(false); }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
                  >
                    <Compass className="w-5 h-5" style={{ color: theme.colors.accent }} />
                    <div className="flex-1">
                      <div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>Take a Tour</div>
                      <div className="text-xs" style={{ color: theme.colors.textDim }}>Learn the interface</div>
                    </div>
                  </button>
                )}

                <div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />

                <button
                  onClick={() => { onOpenSettings(); setMenuOpen(false); }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
                >
                  <Settings className="w-5 h-5" style={{ color: theme.colors.textDim }} />
                  <div className="flex-1">
                    <div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>Settings</div>
                  </div>
                  <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}>
                    {shortcuts.settings ? formatShortcutKeys(shortcuts.settings.keys) : '⌘,'}
                  </span>
                </button>

                <button
                  onClick={() => { onOpenShortcutsHelp(); setMenuOpen(false); }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
                >
                  <HelpCircle className="w-5 h-5" style={{ color: theme.colors.textDim }} />
                  <div className="flex-1">
                    <div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>Keyboard Shortcuts</div>
                  </div>
                  <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}>
                    {shortcuts.help ? formatShortcutKeys(shortcuts.help.keys) : '?'}
                  </span>
                </button>

                <div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />

                <button
                  onClick={() => { onCheckForUpdates(); setMenuOpen(false); }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
                >
                  <RefreshCw className="w-5 h-5" style={{ color: theme.colors.textDim }} />
                  <div className="flex-1">
                    <div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>Check for Updates</div>
                  </div>
                </button>

                <button
                  onClick={() => { onOpenAbout(); setMenuOpen(false); }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
                >
                  <Info className="w-5 h-5" style={{ color: theme.colors.textDim }} />
                  <div className="flex-1">
                    <div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>About Maestro</div>
                  </div>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Main Content: Centered Empty State */}
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="flex flex-col items-center opacity-75 mb-8">
          <Wand2 className="w-16 h-16 mb-4" style={{ color: theme.colors.textDim }} />
          <p className="text-sm text-center max-w-md" style={{ color: theme.colors.textDim }}>
            To get started, create your first agent manually or with the help of the AI wizard.
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-4">
          <button
            onClick={onNewAgent}
            className="flex items-center justify-center gap-3 px-8 py-4 rounded-lg text-base font-bold transition-colors hover:opacity-90 min-w-[180px]"
            style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
          >
            <Bot className="w-5 h-5" />
            New Agent
          </button>
          <button
            onClick={onOpenWizard}
            className="flex items-center justify-center gap-3 px-8 py-4 rounded-lg text-base font-bold transition-colors hover:opacity-90 min-w-[180px]"
            style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
          >
            <Wand2 className="w-5 h-5" />
            Wizard
          </button>
        </div>
      </div>
    </div>
  );
}
