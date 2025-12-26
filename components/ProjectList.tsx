import React, { useState, useEffect } from 'react';
import { User, PhotoTool, Job } from '../types';
import { jobService } from '../services/jobService';

interface ProjectListProps {
  user: User;
  tools: PhotoTool[];
  onSelectProject: (job: Job, tool: PhotoTool) => void;
}

const ProjectList: React.FC<ProjectListProps> = ({ user, tools, onSelectProject }) => {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [selectedToolId, setSelectedToolId] = useState<string>('');

  useEffect(() => {
    jobService.getHistory()
      .then(data => {
        setJobs(data.data);
        setIsLoading(false);
      })
      .catch(err => {
        console.error("Failed to fetch job history:", err);
        setIsLoading(false);
      });
  }, []);

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedToolId || !newProjectName) {
      alert("Please select a tool and enter a project name.");
      return;
    }
    try {
      const newJob = await jobService.createJob(selectedToolId, newProjectName);
      const selectedTool = tools.find(t => t.id === selectedToolId);
      if (selectedTool) {
        onSelectProject(newJob, selectedTool);
      }
    } catch (error) {
      console.error("Failed to create project", error);
      alert("Failed to create project");
    }
  };

  const getStatusChip = (status: string) => {
    switch(status) {
      case 'completed': return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">Completed</span>;
      case 'processing': return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">Processing</span>;
      case 'failed': return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">Failed</span>;
      default: return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">Pending</span>;
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Projects</h1>
            <p className="text-sm text-gray-500 mt-1">{jobs.length} listings</p>
          </div>
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2.5 rounded-lg font-medium text-sm shadow-sm transition-colors flex items-center gap-2"
          >
            <i className="fa-solid fa-plus"></i> New Project
          </button>
        </div>
        
        {isLoading ? (
          <div className="flex justify-center items-center py-20">
            <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
            <span className="ml-4 text-gray-500 font-medium">Loading projects...</span>
          </div>
        ) : (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Listing</th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Tool</th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Created At</th>
                  <th className="px-6 py-4 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {jobs.map(job => (
                  <tr 
                    key={job.id} 
                    className="hover:bg-gray-50 transition-colors cursor-pointer group"
                    onClick={() => {
                        const tool = tools.find(t => t.id === job.tool_id);
                        if (tool) {
                            onSelectProject(job, tool);
                        } else {
                            console.warn('Tool not found for job:', job);
                        }
                    }}
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center">
                        <div className="h-10 w-10 flex-shrink-0 rounded-lg bg-gray-100 flex items-center justify-center text-gray-400">
                          <i className="fa-regular fa-image text-lg"></i>
                        </div>
                        <div className="ml-4">
                          <div className="text-sm font-medium text-gray-900">{job.project_name || 'Untitled Project'}</div>
                          <div className="text-xs text-gray-500">ID: {job.id.substring(0, 8)}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {getStatusChip(job.status)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {(job as any).photo_tools?.name || 'Unknown Tool'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {new Date(job.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <span className="text-indigo-600 hover:text-indigo-900 opacity-0 group-hover:opacity-100 transition-opacity">Open</span>
                    </td>
                  </tr>
                ))}
                {jobs.length === 0 && (
                    <tr>
                        <td colSpan={5} className="px-6 py-12 text-center text-gray-500">
                            No projects yet. Click "New Project" to get started.
                        </td>
                    </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {showCreateModal && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl p-8 transform transition-all scale-100">
              <div className="text-center mb-8">
                <div className="mx-auto w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center mb-4">
                    <i className="fa-solid fa-magic text-indigo-600 text-xl"></i>
                </div>
                <h2 className="text-2xl font-bold text-gray-900">Create New Project</h2>
                <p className="text-sm text-gray-500 mt-2">Start a new batch editing task</p>
              </div>
              
              <form onSubmit={handleCreateProject} className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">1. Select AI Engine</label>
                  <select 
                    onChange={(e) => setSelectedToolId(e.target.value)} 
                    className="block w-full rounded-lg border-gray-300 bg-gray-50 border p-3 text-sm focus:border-indigo-500 focus:ring-indigo-500" 
                    required
                    defaultValue=""
                  >
                    <option value="" disabled>Choose a tool...</option>
                    {tools.map(tool => <option key={tool.id} value={tool.id}>{tool.name} ({tool.point_cost} pts/img)</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">2. Property Address</label>
                  <input 
                    type="text" 
                    value={newProjectName} 
                    onChange={e => setNewProjectName(e.target.value)} 
                    className="block w-full rounded-lg border-gray-300 bg-gray-50 border p-3 text-sm focus:border-indigo-500 focus:ring-indigo-500" 
                    placeholder="e.g., 123 Main St, Vancouver" 
                    required 
                  />
                </div>
                <div className="pt-4 flex gap-3">
                  <button 
                    type="button" 
                    onClick={() => setShowCreateModal(false)} 
                    className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit" 
                    className="flex-1 px-4 py-2.5 bg-indigo-600 rounded-lg text-sm font-medium text-white hover:bg-indigo-700 shadow-sm transition-colors"
                  >
                    Create Project
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ProjectList;
