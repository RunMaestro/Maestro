import React, { useState, useRef, useEffect } from 'react';
import { X, Folder, FileText, Play, CheckSquare } from 'lucide-react';
import type { Theme } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

interface AutoRunSetupModalProps {
  theme: Theme;
  onClose: () => void;
  onFolderSelected: (folderPath: string) => void;
  currentFolder?: string; // If changing existing folder
}

export function AutoRunSetupModal({ theme, onClose, onFolderSelected, currentFolder }: AutoRunSetupModalProps) {
  const [selectedFolder, setSelectedFolder] = useState(currentFolder || '');
  const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
  const layerIdRef = useRef<string>();
  const modalRef = useRef<HTMLDivElement>(null);
  const continueButtonRef = useRef<HTMLButtonElement>(null);

  // Register layer on mount
  useEffect(() => {
    const id = registerLayer({
      type: 'modal',
      priority: MODAL_PRIORITIES.AUTORUN_SETUP,
      blocksLowerLayers: true,
      capturesFocus: true,
      focusTrap: 'strict',
      ariaLabel: 'Set Up Auto Run',
      onEscape: onClose,
    });
    layerIdRef.current = id;

    return () => {
      if (layerIdRef.current) {
        unregisterLayer(layerIdRef.current);
      }
    };
  }, [registerLayer, unregisterLayer]);

  // Update handler when dependencies change
  useEffect(() => {
    if (layerIdRef.current) {
      updateLayerHandler(layerIdRef.current, onClose);
    }
  }, [onClose, updateLayerHandler]);

  // Focus continue button when a folder is selected
  useEffect(() => {
    if (selectedFolder) {
      continueButtonRef.current?.focus();
    }
  }, [selectedFolder]);

  const handleSelectFolder = async () => {
    const folder = await window.maestro.dialog.selectFolder();
    if (folder) {
      setSelectedFolder(folder);
    }
  };

  const handleContinue = () => {
    if (selectedFolder) {
      onFolderSelected(selectedFolder);
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[9999] animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-label="Set Up Auto Run"
      tabIndex={-1}
      ref={modalRef}
      onKeyDown={(e) => {
        // Handle Cmd+O for folder picker
        if ((e.key === 'o' || e.key === 'O') && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
          handleSelectFolder();
          return;
        }
        // Handle Enter for continue when folder is selected
        if (e.key === 'Enter' && selectedFolder) {
          e.preventDefault();
          e.stopPropagation();
          handleContinue();
          return;
        }
        // Stop propagation of all other keyboard events
        if (e.key !== 'Escape') {
          e.stopPropagation();
        }
      }}
    >
      <div
        className="w-[520px] rounded-xl border shadow-2xl overflow-hidden"
        style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
      >
        {/* Header */}
        <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: theme.colors.border }}>
          <h2 className="text-lg font-bold" style={{ color: theme.colors.textMain }}>
            {currentFolder ? 'Change Auto Run Folder' : 'Set Up Auto Run'}
          </h2>
          <button onClick={onClose} style={{ color: theme.colors.textDim }}>
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5">
          {/* Explanation */}
          <div className="space-y-4">
            <p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
              Auto Run lets you manage and execute markdown documents containing automated tasks.
              Select a folder that contains your task documents.
            </p>

            {/* Feature list */}
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <FileText className="w-5 h-5 mt-0.5 flex-shrink-0" style={{ color: theme.colors.accent }} />
                <div>
                  <div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
                    Markdown Documents
                  </div>
                  <div className="text-xs" style={{ color: theme.colors.textDim }}>
                    Each .md file in your folder becomes a runnable document
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <CheckSquare className="w-5 h-5 mt-0.5 flex-shrink-0" style={{ color: theme.colors.accent }} />
                <div>
                  <div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
                    Checkbox Tasks
                  </div>
                  <div className="text-xs" style={{ color: theme.colors.textDim }}>
                    Use markdown checkboxes (- [ ]) to define tasks that can be automated
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <Play className="w-5 h-5 mt-0.5 flex-shrink-0" style={{ color: theme.colors.accent }} />
                <div>
                  <div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
                    Batch Execution
                  </div>
                  <div className="text-xs" style={{ color: theme.colors.textDim }}>
                    Run multiple documents in sequence with loop and reset options
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Folder Selection */}
          <div
            className="p-4 rounded-lg border"
            style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain + '50' }}
          >
            <label className="block text-xs font-bold opacity-70 uppercase mb-2" style={{ color: theme.colors.textMain }}>
              Auto Run Folder
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={selectedFolder}
                onChange={(e) => setSelectedFolder(e.target.value)}
                placeholder="Select a folder containing markdown documents..."
                className="flex-1 p-2 rounded border bg-transparent outline-none font-mono text-sm"
                style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
              />
              <button
                onClick={handleSelectFolder}
                className="p-2 rounded border hover:bg-white/5 transition-colors"
                style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                title="Browse folders (Cmd+O)"
              >
                <Folder className="w-5 h-5" />
              </button>
            </div>
            {selectedFolder && (
              <div className="mt-2 text-xs" style={{ color: theme.colors.success }}>
                Folder selected
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t flex justify-end gap-2" style={{ borderColor: theme.colors.border }}>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
            style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
          >
            Cancel
          </button>
          <button
            ref={continueButtonRef}
            onClick={handleContinue}
            disabled={!selectedFolder}
            className="px-4 py-2 rounded disabled:opacity-50 disabled:cursor-not-allowed outline-none focus:ring-2 focus:ring-offset-1"
            style={{
              backgroundColor: theme.colors.accent,
              color: theme.colors.accentForeground,
              '--tw-ring-color': theme.colors.accent,
            } as React.CSSProperties}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
