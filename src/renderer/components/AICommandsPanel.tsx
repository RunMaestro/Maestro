import React, { useState, useRef } from 'react';
import { Plus, Trash2, Edit2, Save, X, Terminal, Lock, ChevronDown, ChevronRight, Variable, RotateCcw } from 'lucide-react';
import type { Theme, CustomAICommand } from '../types';
import { TEMPLATE_VARIABLES_GENERAL } from '../utils/templateVariables';
import { useTemplateAutocomplete } from '../hooks/useTemplateAutocomplete';
import { TemplateAutocompleteDropdown } from './TemplateAutocompleteDropdown';

interface AICommandsPanelProps {
  theme: Theme;
  customAICommands: CustomAICommand[];
  setCustomAICommands: (commands: CustomAICommand[]) => void;
}

interface EditingCommand {
  id: string;
  command: string;
  description: string;
  prompt: string;
}

export function AICommandsPanel({ theme, customAICommands, setCustomAICommands }: AICommandsPanelProps) {
  const [editingCommand, setEditingCommand] = useState<EditingCommand | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [variablesExpanded, setVariablesExpanded] = useState(false);
  const [expandedCommands, setExpandedCommands] = useState<Set<string>>(new Set());
  const [newCommand, setNewCommand] = useState<EditingCommand>({
    id: '',
    command: '/',
    description: '',
    prompt: '',
  });

  // Refs for textareas
  const newCommandTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editCommandTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Template autocomplete for new command prompt
  const {
    autocompleteState: newAutocompleteState,
    handleKeyDown: handleNewAutocompleteKeyDown,
    handleChange: handleNewAutocompleteChange,
    selectVariable: selectNewVariable,
    autocompleteRef: newAutocompleteRef,
  } = useTemplateAutocomplete({
    textareaRef: newCommandTextareaRef,
    value: newCommand.prompt,
    onChange: (value) => setNewCommand({ ...newCommand, prompt: value }),
  });

  // Template autocomplete for edit command prompt
  const {
    autocompleteState: editAutocompleteState,
    handleKeyDown: handleEditAutocompleteKeyDown,
    handleChange: handleEditAutocompleteChange,
    selectVariable: selectEditVariable,
    autocompleteRef: editAutocompleteRef,
  } = useTemplateAutocomplete({
    textareaRef: editCommandTextareaRef,
    value: editingCommand?.prompt || '',
    onChange: (value) => editingCommand && setEditingCommand({ ...editingCommand, prompt: value }),
  });

  const toggleExpanded = (id: string) => {
    const newExpanded = new Set(expandedCommands);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedCommands(newExpanded);
  };

  const handleSaveEdit = () => {
    if (!editingCommand) return;

    // Ensure command starts with /
    const command = editingCommand.command.startsWith('/')
      ? editingCommand.command
      : `/${editingCommand.command}`;

    const updated = customAICommands.map(cmd =>
      cmd.id === editingCommand.id
        ? { ...cmd, command, description: editingCommand.description, prompt: editingCommand.prompt }
        : cmd
    );
    setCustomAICommands(updated);
    setEditingCommand(null);
  };

  const handleCreate = () => {
    if (!newCommand.command || !newCommand.description || !newCommand.prompt) return;

    // Ensure command starts with /
    const command = newCommand.command.startsWith('/')
      ? newCommand.command
      : `/${newCommand.command}`;

    // Generate ID from command name
    const id = command.slice(1).toLowerCase().replace(/[^a-z0-9]/g, '-');

    // Check for duplicate command
    if (customAICommands.some(cmd => cmd.command === command)) {
      return; // Could show error toast here
    }

    const newCmd: CustomAICommand = {
      id: `custom-${id}-${Date.now()}`,
      command,
      description: newCommand.description,
      prompt: newCommand.prompt,
      isBuiltIn: false,
    };

    setCustomAICommands([...customAICommands, newCmd]);
    setNewCommand({ id: '', command: '/', description: '', prompt: '' });
    setIsCreating(false);
  };

  const handleDelete = (id: string) => {
    const cmd = customAICommands.find(c => c.id === id);
    if (cmd?.isBuiltIn) return; // Can't delete built-in commands
    setCustomAICommands(customAICommands.filter(c => c.id !== id));
  };

  const handleCancelEdit = () => {
    setEditingCommand(null);
  };

  const handleCancelCreate = () => {
    setNewCommand({ id: '', command: '/', description: '', prompt: '' });
    setIsCreating(false);
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-bold opacity-70 uppercase mb-1 flex items-center gap-2">
          <Terminal className="w-3 h-3" />
          Custom AI Commands
        </label>
        <p className="text-xs opacity-50" style={{ color: theme.colors.textDim }}>
          Slash commands available in AI terminal mode. Built-in commands can be edited but not deleted.
        </p>
      </div>

      {/* Template Variables Documentation */}
      <div
        className="rounded-lg border overflow-hidden"
        style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
      >
        <button
          onClick={() => setVariablesExpanded(!variablesExpanded)}
          className="w-full px-3 py-2 flex items-center justify-between hover:bg-white/5 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Variable className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
            <span className="text-xs font-bold uppercase" style={{ color: theme.colors.textDim }}>
              Template Variables
            </span>
          </div>
          {variablesExpanded ? (
            <ChevronDown className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
          )}
        </button>
        {variablesExpanded && (
          <div className="px-3 pb-3 pt-1 border-t" style={{ borderColor: theme.colors.border }}>
            <p className="text-[10px] mb-2" style={{ color: theme.colors.textDim }}>
              Use these variables in your command prompts. They will be replaced with actual values at runtime.
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 max-h-48 overflow-y-auto scrollbar-thin">
              {TEMPLATE_VARIABLES_GENERAL.map(({ variable, description }) => (
                <div key={variable} className="flex items-center gap-2 py-0.5">
                  <code
                    className="text-[10px] font-mono px-1 py-0.5 rounded shrink-0"
                    style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.accent }}
                  >
                    {variable}
                  </code>
                  <span className="text-[10px] truncate" style={{ color: theme.colors.textDim }}>
                    {description}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {!isCreating && (
        <div className="flex justify-start">
          <button
            onClick={() => setIsCreating(true)}
            className="flex items-center gap-2 px-4 py-2 rounded text-sm font-medium transition-all"
            style={{
              backgroundColor: theme.colors.accent,
              color: theme.colors.accentForeground
            }}
          >
            <Plus className="w-4 h-4" />
            Add Command
          </button>
        </div>
      )}

      {/* Create new command form */}
      {isCreating && (
        <div
          className="p-4 rounded-lg border space-y-3"
          style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.accent }}
        >
          <div className="text-xs font-bold uppercase" style={{ color: theme.colors.accent }}>
            New Command
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium opacity-70 mb-1">Command</label>
              <input
                type="text"
                value={newCommand.command}
                onChange={(e) => setNewCommand({ ...newCommand, command: e.target.value })}
                placeholder="/mycommand"
                className="w-full p-2 rounded border bg-transparent outline-none text-sm font-mono"
                style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
              />
            </div>
            <div>
              <label className="block text-xs font-medium opacity-70 mb-1">Description</label>
              <input
                type="text"
                value={newCommand.description}
                onChange={(e) => setNewCommand({ ...newCommand, description: e.target.value })}
                placeholder="Short description for autocomplete"
                className="w-full p-2 rounded border bg-transparent outline-none text-sm"
                style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
              />
            </div>
          </div>
          <div className="relative">
            <label className="block text-xs font-medium opacity-70 mb-1">Prompt</label>
            <textarea
              ref={newCommandTextareaRef}
              value={newCommand.prompt}
              onChange={handleNewAutocompleteChange}
              onKeyDown={(e) => {
                if (handleNewAutocompleteKeyDown(e)) {
                  return;
                }
                // Allow Tab for indentation when autocomplete is not active
                if (e.key === 'Tab') {
                  e.preventDefault();
                  const textarea = e.currentTarget;
                  const start = textarea.selectionStart;
                  const end = textarea.selectionEnd;
                  const value = textarea.value;
                  const newValue = value.substring(0, start) + '\t' + value.substring(end);
                  setNewCommand({ ...newCommand, prompt: newValue });
                  setTimeout(() => {
                    textarea.selectionStart = textarea.selectionEnd = start + 1;
                  }, 0);
                }
              }}
              placeholder="The actual prompt sent to the AI agent when this command is invoked... (type {{ for variables)"
              rows={10}
              className="w-full p-2 rounded border bg-transparent outline-none text-sm resize-y scrollbar-thin min-h-[150px]"
              style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
            />
            <TemplateAutocompleteDropdown
              ref={newAutocompleteRef}
              theme={theme}
              state={newAutocompleteState}
              onSelect={selectNewVariable}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={handleCancelCreate}
              className="flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium transition-all"
              style={{
                backgroundColor: theme.colors.bgActivity,
                color: theme.colors.textMain,
                border: `1px solid ${theme.colors.border}`
              }}
            >
              <X className="w-3 h-3" />
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!newCommand.command || !newCommand.description || !newCommand.prompt}
              className="flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium transition-all disabled:opacity-50"
              style={{
                backgroundColor: theme.colors.success,
                color: '#000000'
              }}
            >
              <Save className="w-3 h-3" />
              Create
            </button>
          </div>
        </div>
      )}

      {/* Existing commands list - collapsible style */}
      <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1 scrollbar-thin">
        {[...customAICommands].sort((a, b) => a.command.localeCompare(b.command)).map((cmd) => (
          <div
            key={cmd.id}
            className="rounded-lg border overflow-hidden"
            style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
          >
            {editingCommand?.id === cmd.id ? (
              // Editing mode
              <div className="p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono font-bold text-sm" style={{ color: theme.colors.accent }}>
                    {cmd.command}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={handleCancelEdit}
                      className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-all"
                      style={{
                        backgroundColor: theme.colors.bgActivity,
                        color: theme.colors.textMain,
                        border: `1px solid ${theme.colors.border}`,
                      }}
                    >
                      <X className="w-3 h-3" />
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveEdit}
                      className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-all"
                      style={{
                        backgroundColor: theme.colors.success,
                        color: '#000000',
                      }}
                    >
                      <Save className="w-3 h-3" />
                      Save
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium opacity-70 mb-1">Command</label>
                    <input
                      type="text"
                      value={editingCommand.command}
                      onChange={(e) => setEditingCommand({ ...editingCommand, command: e.target.value })}
                      className="w-full p-2 rounded border bg-transparent outline-none text-sm font-mono"
                      style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium opacity-70 mb-1">Description</label>
                    <input
                      type="text"
                      value={editingCommand.description}
                      onChange={(e) => setEditingCommand({ ...editingCommand, description: e.target.value })}
                      className="w-full p-2 rounded border bg-transparent outline-none text-sm"
                      style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                    />
                  </div>
                </div>
                <div className="relative">
                  <textarea
                    ref={editCommandTextareaRef}
                    value={editingCommand.prompt}
                    onChange={handleEditAutocompleteChange}
                    onKeyDown={(e) => {
                      if (handleEditAutocompleteKeyDown(e)) {
                        return;
                      }
                      if (e.key === 'Tab') {
                        e.preventDefault();
                        const textarea = e.currentTarget;
                        const start = textarea.selectionStart;
                        const end = textarea.selectionEnd;
                        const value = textarea.value;
                        const newValue = value.substring(0, start) + '\t' + value.substring(end);
                        setEditingCommand({ ...editingCommand, prompt: newValue });
                        setTimeout(() => {
                          textarea.selectionStart = textarea.selectionEnd = start + 1;
                        }, 0);
                      }
                    }}
                    rows={15}
                    className="w-full p-2 rounded border bg-transparent outline-none text-sm resize-y scrollbar-thin min-h-[300px] font-mono"
                    style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                  />
                  <TemplateAutocompleteDropdown
                    ref={editAutocompleteRef}
                    theme={theme}
                    state={editAutocompleteState}
                    onSelect={selectEditVariable}
                  />
                </div>
              </div>
            ) : (
              // Display mode - collapsible
              <>
                <button
                  onClick={() => toggleExpanded(cmd.id)}
                  className="w-full px-3 py-2.5 flex items-center justify-between hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    {expandedCommands.has(cmd.id) ? (
                      <ChevronDown className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
                    )}
                    <span className="font-mono font-bold text-sm" style={{ color: theme.colors.accent }}>
                      {cmd.command}
                    </span>
                    {cmd.isBuiltIn && (
                      <span
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                        style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
                      >
                        <Lock className="w-2.5 h-2.5" />
                        Built-in
                      </span>
                    )}
                  </div>
                  <span className="text-xs truncate max-w-[300px]" style={{ color: theme.colors.textDim }}>
                    {cmd.description}
                  </span>
                </button>
                {expandedCommands.has(cmd.id) && (
                  <div className="px-3 pb-3 pt-1 border-t" style={{ borderColor: theme.colors.border }}>
                    <div className="flex items-center justify-end gap-1 mb-2">
                      <button
                        onClick={() => setEditingCommand({
                          id: cmd.id,
                          command: cmd.command,
                          description: cmd.description,
                          prompt: cmd.prompt,
                        })}
                        className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-all hover:bg-white/10"
                        style={{ color: theme.colors.textDim }}
                        title="Edit command"
                      >
                        <Edit2 className="w-3 h-3" />
                        Edit
                      </button>
                      {!cmd.isBuiltIn && (
                        <button
                          onClick={() => handleDelete(cmd.id)}
                          className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-all hover:bg-white/10"
                          style={{ color: theme.colors.error }}
                          title="Delete command"
                        >
                          <Trash2 className="w-3 h-3" />
                          Delete
                        </button>
                      )}
                    </div>
                    <div
                      className="text-xs p-2 rounded font-mono overflow-y-auto max-h-48 scrollbar-thin whitespace-pre-wrap"
                      style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
                    >
                      {cmd.prompt.length > 500 ? cmd.prompt.substring(0, 500) + '...' : cmd.prompt}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {customAICommands.length === 0 && !isCreating && (
        <div
          className="p-6 rounded-lg border border-dashed text-center"
          style={{ borderColor: theme.colors.border }}
        >
          <Terminal className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm opacity-50" style={{ color: theme.colors.textDim }}>
            No custom AI commands configured
          </p>
          <button
            onClick={() => setIsCreating(true)}
            className="mt-2 text-xs font-medium"
            style={{ color: theme.colors.accent }}
          >
            Create your first command
          </button>
        </div>
      )}
    </div>
  );
}
