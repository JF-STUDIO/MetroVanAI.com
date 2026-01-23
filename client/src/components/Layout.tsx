
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
  const isPro = currentView === 'editor' || currentView === 'admin';
  return (
    <div className={`app-shell flex flex-col ${isPro ? 'theme-pro' : ''}`}>
      {/* Navigation */}
      <nav className="nav-shell sticky top-0 z-50 px-6 py-4 flex items-center justify-between">
        <button
          type="button"
          className="flex items-center gap-3"
          onClick={() => onNavigate('home')}
          aria-label="Go to home"
        >
          <div
            className={`w-10 h-10 rounded-2xl flex items-center justify-center border ${
              isPro ? 'border-white/20 bg-white/10 text-white' : 'border-white/60 bg-white/70 text-ink'
            }`}
          >
            <i className={`fa-solid fa-camera-retro text-base ${isPro ? 'text-white' : 'text-ink'}`}></i>
          </div>
          <span className="text-lg font-semibold tracking-tight text-ink">Metrovan AI</span>
        </button>

        <div className="flex items-center gap-3">
          {user ? (
            <>
              <button
                type="button"
                className={`nav-link ${currentView === 'editor' ? 'nav-link-active' : ''}`}
                onClick={() => onNavigate('editor')}
              >
                Studio
              </button>
              <button
                type="button"
                className={`nav-link ${currentView === 'pricing' ? 'nav-link-active' : ''}`}
                onClick={() => onNavigate('pricing')}
              >
                Pricing
              </button>
              {user.isAdmin && (
                <button
                  type="button"
                  className={`nav-link ${currentView === 'admin' ? 'nav-link-active' : ''}`}
                  onClick={() => onNavigate('admin')}
                >
                  Admin
                </button>
              )}
              <div className="flex items-center gap-3 pl-4 nav-divider">
                <div className="flex flex-col items-end">
                  <span className="text-[10px] text-muted font-semibold uppercase tracking-widest">Balance</span>
                  <span className="balance-pill">
                    <i className="fa-solid fa-bolt-lightning text-amber-500 mr-1"></i>
                    {user.points} credits
                  </span>
                </div>
                <div
                  className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold uppercase ${
                    isPro ? 'bg-white/10 border border-white/20 text-white' : 'bg-white/70 border border-white/60 text-ink'
                  }`}
                >
                  {user.name.substring(0, 2)}
                </div>
                <button
                  type="button"
                  onClick={onLogout}
                  className="w-9 h-9 rounded-full btn-ghost flex items-center justify-center"
                  aria-label="Sign out"
                >
                  <i className="fa-solid fa-right-from-bracket"></i>
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={() => onNavigate('login')}
              className="px-5 py-2 rounded-full btn-secondary text-sm font-semibold"
            >
              Sign In
            </button>
          )}
        </div>
      </nav>

      <main className="flex-1 overflow-auto">
        {children}
      </main>

      <footer className="footer-shell py-8 text-center text-sm">
        &copy; 2024 Metrovan AI. All rights reserved.
      </footer>
    </div>
  );
};

export default Layout;
