
import { STORAGE_KEYS, DEFAULT_TOOLS } from '../constants';
import { User, PhotoTool, EditSession } from '../types';

export const storage = {
  getUser: (): User | null => {
    const data = localStorage.getItem(STORAGE_KEYS.USER);
    return data ? JSON.parse(data) : null;
  },
  setUser: (user: User | null) => {
    if (user) localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user));
    else localStorage.removeItem(STORAGE_KEYS.USER);
  },
  getTools: (): PhotoTool[] => {
    const data = localStorage.getItem(STORAGE_KEYS.TOOLS);
    return data ? JSON.parse(data) : DEFAULT_TOOLS;
  },
  setTools: (tools: PhotoTool[]) => {
    localStorage.setItem(STORAGE_KEYS.TOOLS, JSON.stringify(tools));
  },
  addTool: (tool: PhotoTool) => {
    const tools = storage.getTools();
    storage.setTools([...tools, tool]);
  },
  getSessions: (): EditSession[] => {
    const data = localStorage.getItem(STORAGE_KEYS.SESSIONS);
    return data ? JSON.parse(data) : [];
  },
  saveSession: (session: EditSession) => {
    const sessions = storage.getSessions();
    localStorage.setItem(STORAGE_KEYS.SESSIONS, JSON.stringify([session, ...sessions]));
  }
};
