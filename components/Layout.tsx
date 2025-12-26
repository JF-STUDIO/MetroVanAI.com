
import React from 'react';
import { User } from '../types';

interface LayoutProps {
  user: User | null;
  children: React.ReactNode;
  onLogout: () => void;
  onNavigate: (view: string) => void;
  currentView: string;
}

const Layout: React.FC<LayoutProps> = ({ user, children, onLogout, onNavigate, currentView }) => {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 glass border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <div 
          className="flex items-center gap-2 cursor-pointer"
          onClick={() => onNavigate('home')}
        >
          <div className="w-10 h-10 gradient-btn rounded-xl flex items-center justify-center">
            <i className="fa-solid fa-camera-retro text-white text-xl"></i>
          </div>
          <span className="text-xl font-bold tracking-tight">METROVAN<span className="text-indigo-400">AI</span></span>
        </div>

        <div className="flex items-center gap-6">
          {user ? (
            <>
              <div 
                className={`cursor-pointer hover:text-indigo-400 transition ${currentView === 'editor' ? 'text-indigo-400' : ''}`}
                onClick={() => onNavigate('editor')}
              >
                Studio
              </div>
              <div 
                className={`cursor-pointer hover:text-indigo-400 transition ${currentView === 'pricing' ? 'text-indigo-400' : ''}`}
                onClick={() => onNavigate('pricing')}
              >
                Pricing
              </div>
              {user.isAdmin && (
                <div 
                  className={`cursor-pointer hover:text-indigo-400 transition font-medium ${currentView === 'admin' ? 'text-indigo-400' : ''}`}
                  onClick={() => onNavigate('admin')}
                >
                  Admin
                </div>
              )}
              <div className="flex items-center gap-3 pl-6 border-l border-white/10">
                <div className="flex flex-col items-end">
                  <span className="text-xs text-gray-400 font-bold uppercase tracking-widest">Balance</span>
                  <span className="text-sm font-semibold text-white">
                    <i className="fa-solid fa-bolt-lightning text-yellow-500 mr-1"></i>
                    {user.points} Points
                  </span>
                </div>
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-xs font-bold uppercase">
                  {user.name.substring(0, 2)}
                </div>
                <button 
                  onClick={onLogout}
                  className="p-2 hover:bg-white/5 rounded-lg transition text-gray-400 hover:text-red-400"
                >
                  <i className="fa-solid fa-right-from-bracket"></i>
                </button>
              </div>
            </>
          ) : (
            <button 
              onClick={() => onNavigate('login')}
              className="px-6 py-2 rounded-full border border-white/20 hover:bg-white/5 transition"
            >
              Sign In
            </button>
          )}
        </div>
      </nav>

      <main className="flex-1 overflow-auto">
        {children}
      </main>

      <footer className="py-8 border-t border-white/5 text-center text-gray-500 text-sm">
        &copy; 2024 Metrovan AI. All rights reserved.
      </footer>
    </div>
  );
};

export default Layout;