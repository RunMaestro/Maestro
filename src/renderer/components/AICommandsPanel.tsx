import React, { useState } from 'react';
import { Plus, Trash2, Edit2, Save, X, Terminal, Lock, ChevronDown, ChevronRight, Variable } from 'lucide-react';
import type { Theme, CustomAICommand } from '../types';
import { TEMPLATE_VARIABLES } from '../utils/templateVariables';

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
  const [newCommand, setNewCommand] = useState<EditingCommand>({
    id: '',
    command: '/',
    description: '',
    prompt: '',
  });

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
              {TEMPLATE_VARIABLES.map(({ variable, description }) => (
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
              color: 'white'
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
          <div>
            <label className="block text-xs font-medium opacity-70 mb-1">Prompt</label>
            <textarea
              value={newCommand.prompt}
              onChange={(e) => setNewCommand({ ...newCommand, prompt: e.target.value })}
              placeholder="The actual prompt sent to the AI agent when this command is invoked..."
              rows={4}
              className="w-full p-2 rounded border bg-transparent outline-none text-sm resize-none scrollbar-thin"
              style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
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
                color: 'white'
              }}
            >
              <Save className="w-3 h-3" />
              Create
            </button>
          </div>
        </div>
      )}

      {/* Existing commands list */}
      <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1 scrollbar-thin">
        {customAICommands.map((cmd) => (
          <div
            key={cmd.id}
            className="p-3 rounded-lg border"
            style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
          >
            {editingCommand?.id === cmd.id ? (
              // Editing mode
              <div className="space-y-3">
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
                <div>
                  <label className="block text-xs font-medium opacity-70 mb-1">Prompt</label>
                  <textarea
                    value={editingCommand.prompt}
                    onChange={(e) => setEditingCommand({ ...editingCommand, prompt: e.target.value })}
                    rows={4}
                    className="w-full p-2 rounded border bg-transparent outline-none text-sm resize-none scrollbar-thin"
                    style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={handleCancelEdit}
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
                    onClick={handleSaveEdit}
                    className="flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium transition-all"
                    style={{
                      backgroundColor: theme.colors.success,
                      color: 'white'
                    }}
                  >
                    <Save className="w-3 h-3" />
                    Save
                  </button>
                </div>
              </div>
            ) : (
              // Display mode
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-sm" style={{ color: theme.colors.accent }}>
                      {cmd.command}
                    </span>
                    {cmd.isBuiltIn && (
                      <span
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                        style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
                        title="Built-in command - can be edited but not deleted"
                      >
                        <Lock className="w-2.5 h-2.5" />
                        Built-in
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setEditingCommand({
                        id: cmd.id,
                        command: cmd.command,
                        description: cmd.description,
                        prompt: cmd.prompt,
                      })}
                      className="p-1.5 rounded hover:bg-white/10 transition-colors"
                      style={{ color: theme.colors.textDim }}
                      title="Edit command"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    {!cmd.isBuiltIn && (
                      <button
                        onClick={() => handleDelete(cmd.id)}
                        className="p-1.5 rounded hover:bg-white/10 transition-colors"
                        style={{ color: theme.colors.error }}
                        title="Delete command"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                <div className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
                  {cmd.description}
                </div>
                <div
                  className="text-xs p-2 rounded font-mono overflow-hidden line-clamp-3"
                  style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
                  title={cmd.prompt}
                >
                  {cmd.prompt}
                </div>
              </div>
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
