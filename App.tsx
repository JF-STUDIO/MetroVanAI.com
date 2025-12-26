import React, { useState, useEffect } from 'react';
import Layout from './components/Layout';
import Home from './components/Home';
import Editor from './components/Editor';
import { User, PhotoTool } from './types';
import { supabase } from './services/supabaseClient';
import { jobService } from './services/jobService';

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [tools, setTools] = useState<PhotoTool[]>([]);
  const [view, setView] = useState<string>('home');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUserAndSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        try {
          const profile = await jobService.getProfile();
          setUser({
            id: session.user.id,
            email: session.user.email || '',
            name: session.user.email?.split('@')[0] || '',
            points: profile.points,
            isAdmin: profile.is_admin || false
          });
        } catch (e) { console.error('Failed to load profile', e); }
      }
      setLoading(false);
    };
    fetchUserAndSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        jobService.getProfile().then(profile => {
          setUser({
            id: session.user.id,
            email: session.user.email || '',
            name: session.user.email?.split('@')[0] || '',
            points: profile.points,
            isAdmin: profile.is_admin || false
          });
        }).catch(e => console.error('Failed to load profile on auth change', e));
      } else {
        setUser(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (user) {
      jobService.getTools().then(setTools).catch(err => console.error('Failed to fetch tools:', err));
    }
  }, [user]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (isRegister) {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        alert('Check your email for confirmation!');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        setView('editor');
      }
    } catch (error) {
      if (error instanceof Error) {
        alert(error.message);
      } else {
        alert('An unknown error occurred.');
      }
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setView('home');
  };

  if (loading) return <div className="h-screen flex items-center justify-center bg-gray-900 text-white">Loading...</div>;

  const renderContent = () => {
    switch (view) {
      case 'home':
        return <Home onStart={() => user ? setView('editor') : setView('login')} />;
      case 'login':
        return (
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="glass w-full max-w-md p-10 rounded-[2.5rem] border border-white/10 shadow-2xl">
              <div className="text-center mb-10">
                <h2 className="text-3xl font-black mb-2 uppercase tracking-tighter">{isRegister ? 'Join Metrovan AI' : 'Welcome Back'}</h2>
                <p className="text-gray-500">Professional architectural AI studio.</p>
              </div>
              <form onSubmit={handleAuth} className="space-y-6">
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Email Address</label>
                  <input type="email" required className="w-full bg-white/5 border border-white/10 rounded-2xl px-5 py-4" placeholder="Enter your email" value={email} onChange={e => setEmail(e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Password</label>
                  <input type="password" required className="w-full bg-white/5 border border-white/10 rounded-2xl px-5 py-4" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} />
                </div>
                <button className="w-full py-4 gradient-btn rounded-2xl font-black uppercase tracking-widest text-white shadow-lg">
                  {isRegister ? 'Create Account' : 'Sign In'}
                </button>
              </form>
              <div className="mt-8 text-center text-sm text-gray-500">
                {isRegister ? 'Already have an account?' : "Don't have an account?"}
                <button onClick={() => setIsRegister(!isRegister)} className="ml-1 text-indigo-400 font-bold hover:underline">
                  {isRegister ? 'Sign In' : 'Create one'}
                </button>
              </div>
            </div>
          </div>
        );
      case 'editor':
        return user ? <Editor user={user} tools={tools} onUpdateUser={setUser} /> : null;
      default:
        return <Home onStart={() => setView('editor')} />;
    }
  };

  return (
    <Layout user={user} onLogout={logout} onNavigate={setView} currentView={view}>
      {renderContent()}
    </Layout>
  );
};

export default App;
