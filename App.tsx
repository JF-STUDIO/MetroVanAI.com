import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import Home from './components/Home';
import Editor from './components/Editor';
import Admin from './components/Admin';
import { User, Workflow } from './types';
import { supabase } from './services/supabaseClient';
import { jobService } from './services/jobService';

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const fetchUserAndSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        try {
          const profile = await jobService.getProfile();
          const displayName = (session.user.user_metadata?.full_name as string | undefined) || session.user.email?.split('@')[0] || '';
          setUser({
            id: session.user.id,
            email: session.user.email || '',
            name: displayName,
            points: profile.available_credits ?? profile.points ?? 0,
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
          const displayName = (session.user.user_metadata?.full_name as string | undefined) || session.user.email?.split('@')[0] || '';
          setUser({
            id: session.user.id,
            email: session.user.email || '',
            name: displayName,
            points: profile.available_credits ?? profile.points ?? 0,
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
      jobService.getWorkflows().then(setWorkflows).catch(err => console.error('Failed to fetch workflows:', err));
    }
  }, [user]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setAuthError(null);
    setAuthNotice(null);
    try {
      if (isRegister) {
        const normalizedName = fullName.trim();
        if (!normalizedName) {
          setAuthError('Please enter your full name.');
          return;
        }
        const hasLetter = /[A-Za-z]/.test(password);
        const hasSymbol = /[^A-Za-z0-9\s]/.test(password);
        if (!hasLetter || !hasSymbol) {
          setAuthError('Password must include at least one letter and one symbol.');
          return;
        }
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: normalizedName },
            emailRedirectTo: `${window.location.origin}/auth/callback`
          }
        });
        if (error) throw error;
        setAuthNotice('Check your email for confirmation.');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate('/studio', { replace: true });
      }
    } catch (error) {
      if (error instanceof Error) {
        setAuthError(error.message);
      } else {
        setAuthError('An unknown error occurred.');
      }
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setUser(null);
    navigate('/', { replace: true });
    setAuthError(null);
    setAuthNotice(null);
  };

  if (loading) return <div className="h-screen flex items-center justify-center bg-gray-900 text-white">Loading...</div>;

  const currentView = (() => {
    const path = location.pathname;
    if (path.startsWith('/admin')) return 'admin';
    if (path.startsWith('/studio')) return 'editor';
    if (path.startsWith('/pricing')) return 'pricing';
    if (path.startsWith('/auth') || path.startsWith('/login')) return 'login';
    return 'home';
  })();

  const handleNavigate = (target: string) => {
    switch (target) {
      case 'home':
        navigate('/');
        break;
      case 'login':
        navigate('/login');
        break;
      case 'editor':
        navigate('/studio');
        break;
      case 'admin':
        navigate('/admin');
        break;
      case 'pricing':
        navigate('/pricing');
        break;
      default:
        navigate('/');
    }
  };

  const loginView = (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="glass w-full max-w-md p-10 rounded-[2.5rem] border border-white/10 shadow-2xl">
        <div className="text-center mb-10">
          <h2 className="text-3xl font-black mb-2 uppercase tracking-tighter">{isRegister ? 'Join Metrovan AI' : 'Welcome Back'}</h2>
          <p className="text-gray-500">Professional architectural AI studio.</p>
        </div>
        {(authError || authNotice) && (
          <div className="mb-6 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-xs">
            {authError && <div className="text-red-400">{authError}</div>}
            {authNotice && <div className="text-emerald-300">{authNotice}</div>}
          </div>
        )}
        <form onSubmit={handleAuth} className="space-y-6">
          {isRegister && (
            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Full Name</label>
              <input
                type="text"
                required
                className="w-full bg-white/5 border border-white/10 rounded-2xl px-5 py-4"
                placeholder="Enter your name"
                value={fullName}
                onChange={e => setFullName(e.target.value)}
              />
            </div>
          )}
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Email Address</label>
            <input type="email" required className="w-full bg-white/5 border border-white/10 rounded-2xl px-5 py-4" placeholder="Enter your email" value={email} onChange={e => setEmail(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Password</label>
            <input type="password" required className="w-full bg-white/5 border border-white/10 rounded-2xl px-5 py-4" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} />
            {isRegister && (
              <p className="mt-2 text-[11px] text-gray-500">
                Must include at least one letter and one symbol.
              </p>
            )}
          </div>
          <button className="w-full py-4 gradient-btn rounded-2xl font-black uppercase tracking-widest text-white shadow-lg">
            {isRegister ? 'Create Account' : 'Sign In'}
          </button>
        </form>
        <div className="mt-8 text-center text-sm text-gray-500">
          {isRegister ? 'Already have an account?' : "Don't have an account?"}
          <button onClick={() => { setIsRegister(!isRegister); setAuthError(null); setAuthNotice(null); }} className="ml-1 text-indigo-400 font-bold hover:underline">
            {isRegister ? 'Sign In' : 'Create one'}
          </button>
        </div>
      </div>
    </div>
  );

  const authCallbackView = (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="glass w-full max-w-md p-10 rounded-[2.5rem] border border-white/10 shadow-2xl text-center">
        <h2 className="text-2xl font-black mb-3 uppercase tracking-tight">Verifying Email</h2>
        <p className="text-sm text-gray-400">Please wait while we confirm your account...</p>
      </div>
    </div>
  );

  useEffect(() => {
    if (!location.pathname.startsWith('/auth/callback')) return;
    let active = true;
    const run = async () => {
      try {
        const url = new URL(window.location.href);
        const code = url.searchParams.get('code');
        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else {
          await supabase.auth.getSession();
        }
        if (active) navigate('/studio', { replace: true });
      } catch (error) {
        if (active) {
          setAuthNotice('Email confirmed. Please sign in.');
          navigate('/login', { replace: true });
        }
      }
    };
    run();
    return () => {
      active = false;
    };
  }, [location.pathname, navigate]);

  return (
    <Layout user={user} onLogout={logout} onNavigate={handleNavigate} currentView={currentView}>
      <Routes>
        <Route path="/" element={<Home onStart={() => navigate(user ? '/studio' : '/login')} />} />
        <Route path="/login" element={user ? <Navigate to="/studio" replace /> : loginView} />
        <Route path="/auth/callback" element={authCallbackView} />
        <Route path="/studio" element={user ? <Editor user={user} workflows={workflows} onUpdateUser={setUser} /> : <Navigate to="/login" replace />} />
        <Route path="/admin" element={user && user.isAdmin ? <Admin user={user} /> : <Navigate to={user ? '/studio' : '/login'} replace />} />
        <Route path="/pricing" element={<Home onStart={() => navigate(user ? '/studio' : '/login')} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
};

export default App;
