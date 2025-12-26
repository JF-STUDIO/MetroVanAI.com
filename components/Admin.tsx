
import React, { useState } from 'react';
import { PhotoTool, APIProvider } from '../types';
import { storage } from '../services/localStorageService';
import { RUNNINGHUB_DEFAULT_KEY, DEFAULT_TOOLS } from '../constants';

interface AdminProps {
  tools: PhotoTool[];
  onUpdateTools: (tools: PhotoTool[]) => void;
}

const Admin: React.FC<AdminProps> = ({ tools, onUpdateTools }) => {
  const [newTool, setNewTool] = useState<Partial<PhotoTool>>({
    name: '',
    description: '',
    icon: 'fa-star',
    promptTemplate: '',
    category: 'Enhancement',
    pointCost: 1,
    apiProvider: 'gemini',
    workflowId: '',
    inputNodeKey: 'input_image',
    externalApiKey: ''
  });

  const handleAddTool = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTool.name) return;

    const tool: PhotoTool = {
      id: `tool-${Date.now()}`,
      name: newTool.name!,
      description: newTool.description || '',
      icon: newTool.icon || 'fa-star',
      promptTemplate: newTool.promptTemplate || '',
      category: newTool.category as any,
      pointCost: newTool.pointCost || 1,
      apiProvider: (newTool.apiProvider as APIProvider) || 'gemini',
      workflowId: newTool.workflowId || '',
      inputNodeKey: newTool.inputNodeKey || 'input_image',
      externalApiKey: newTool.apiProvider === 'runninghub' ? (newTool.externalApiKey || RUNNINGHUB_DEFAULT_KEY) : ''
    };

    const updatedTools = [...tools, tool];
    storage.setTools(updatedTools);
    onUpdateTools(updatedTools);
    setNewTool({ 
      name: '', 
      description: '', 
      icon: 'fa-star', 
      promptTemplate: '', 
      category: 'Enhancement', 
      pointCost: 1, 
      apiProvider: 'gemini',
      workflowId: '',
      inputNodeKey: 'input_image',
      externalApiKey: ''
    });
  };

  const deleteTool = (id: string) => {
    const updatedTools = tools.filter(t => t.id !== id);
    storage.setTools(updatedTools);
    onUpdateTools(updatedTools);
  };

  const resetToDefaults = () => {
    if (window.confirm("This will delete your custom tools and reset to factory defaults (with updated API keys). Continue?")) {
      storage.setTools(DEFAULT_TOOLS);
      onUpdateTools(DEFAULT_TOOLS);
      alert("System tools synchronized successfully.");
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <div className="mb-12 flex justify-between items-end">
        <div>
          <h1 className="text-4xl font-black mb-2 uppercase tracking-tighter">Control Center</h1>
          <p className="text-gray-400 font-medium">Add new AI engines and manage system points.</p>
        </div>
        <button 
          onClick={resetToDefaults}
          className="px-4 py-2 border border-white/10 rounded-xl text-[10px] font-black uppercase tracking-widest text-gray-500 hover:text-white hover:bg-white/5 transition"
        >
          Reset to Defaults
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
        <div className="glass p-8 rounded-3xl">
          <h2 className="text-xl font-bold mb-6 flex items-center gap-2 uppercase tracking-widest">
            <i className="fa-solid fa-plus-circle text-indigo-400"></i>
            Deploy New Engine
          </h2>
          <form onSubmit={handleAddTool} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase mb-1 tracking-widest">Engine Name</label>
              <input 
                type="text" 
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500 transition text-white"
                value={newTool.name}
                onChange={e => setNewTool({...newTool, name: e.target.value})}
                placeholder="e.g. Real Estate Pro V2"
                required
              />
            </div>
            
            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase mb-1 tracking-widest">API Provider</label>
              <select 
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500 transition text-white"
                value={newTool.apiProvider}
                onChange={e => setNewTool({...newTool, apiProvider: e.target.value as APIProvider})}
              >
                <option value="gemini" className="bg-[#111]">Google Gemini AI</option>
                <option value="runninghub" className="bg-[#111]">RunningHub (ComfyUI)</option>
              </select>
            </div>

            {newTool.apiProvider === 'gemini' ? (
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1 tracking-widest">AI Prompt Template</label>
                <textarea 
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500 h-24 transition text-white"
                  value={newTool.promptTemplate}
                  onChange={e => setNewTool({...newTool, promptTemplate: e.target.value})}
                  placeholder="Instructions for the Gemini model..."
                  required
                />
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase mb-1 tracking-widest">Workflow ID</label>
                    <input 
                      type="text" 
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500 transition text-white text-xs"
                      value={newTool.workflowId}
                      onChange={e => setNewTool({...newTool, workflowId: e.target.value})}
                      placeholder="e.g. 100234 (Numeric)"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase mb-1 tracking-widest text-indigo-400">Input Node Key</label>
                    <input 
                      type="text" 
                      className="w-full bg-indigo-500/5 border border-indigo-500/20 rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500 transition text-white text-xs"
                      value={newTool.inputNodeKey}
                      onChange={e => setNewTool({...newTool, inputNodeKey: e.target.value})}
                      placeholder="e.g. input_image"
                      required
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-1 tracking-widest text-indigo-400">External API Key (Token)</label>
                  <input 
                    type="text" 
                    className="w-full bg-indigo-500/5 border border-indigo-500/20 rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500 transition text-white text-sm"
                    value={newTool.externalApiKey}
                    onChange={e => setNewTool({...newTool, externalApiKey: e.target.value})}
                    placeholder="Enter RunningHub API Token"
                  />
                  <p className="text-[10px] text-gray-600 mt-1 italic">Current active key will be used by default.</p>
                </div>
              </>
            )}

            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase mb-1 tracking-widest">Description</label>
              <input 
                type="text" 
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500 transition text-white"
                value={newTool.description}
                onChange={e => setNewTool({...newTool, description: e.target.value})}
                placeholder="High-end retouching workflow"
              />
            </div>

            <div className="flex gap-4">
               <div className="flex-1">
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1 tracking-widest">Point Cost</label>
                <input 
                  type="number" 
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500 transition text-white"
                  value={newTool.pointCost}
                  onChange={e => setNewTool({...newTool, pointCost: parseInt(e.target.value) || 0})}
                  required
                />
               </div>
            </div>
            <button className="w-full py-4 gradient-btn rounded-xl font-black uppercase tracking-widest text-white shadow-lg active:scale-95 transition">
              Launch Engine
            </button>
          </form>
        </div>

        <div>
          <h2 className="text-xl font-bold mb-6 uppercase tracking-widest">Active Engines</h2>
          <div className="space-y-4">
            {tools.map(tool => (
              <div key={tool.id} className="glass p-5 rounded-2xl flex items-center justify-between border-l-4 border-indigo-500">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-400">
                    <i className={`fa-solid ${tool.icon}`}></i>
                  </div>
                  <div>
                    <h3 className="font-bold text-white text-sm">{tool.name}</h3>
                    <div className="flex gap-2 mt-1">
                      <span className="text-[8px] font-black bg-white/5 px-2 py-0.5 rounded uppercase tracking-widest text-gray-400">{tool.apiProvider}</span>
                      {tool.apiProvider === 'runninghub' && (
                        <span className="text-[8px] font-black bg-indigo-500/10 px-2 py-0.5 rounded uppercase tracking-widest text-indigo-400">Workflow: {tool.workflowId}</span>
                      )}
                    </div>
                  </div>
                </div>
                <button 
                  onClick={() => deleteTool(tool.id)}
                  className="p-2 hover:bg-red-500/10 text-gray-500 hover:text-red-500 rounded-lg transition"
                >
                  <i className="fa-solid fa-trash-can"></i>
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Admin;
