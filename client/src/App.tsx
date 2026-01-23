import React, { useState, useEffect, Suspense } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import { Workflow } from './types';
import { supabase } from './services/supabaseClient';
import { jobService } from './services/jobService';
import { useAuth } from './contexts/AuthContext';

const Home = React.lazy(() => import('./components/Home'));
const Pricing = React.lazy(() => import('./components/Pricing'));
const Editor = React.lazy(() => import('./components/Editor'));
const Admin = React.lazy(() => import('./components/Admin'));

const App: React.FC = () => {
  const { user, loading: authLoading, signOut } = useAuth();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [resetConfirm, setResetConfirm] = useState('');
  const [resetReady, setResetReady] = useState(false);
  const [, setLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (user) {
      jobService.getWorkflows().then(setWorkflows).catch(err => console.error('Failed to fetch workflows:', err));
    }
  }, [user]);

  const normalizeAuthError = (message: string) => {
    const lower = message.toLowerCase();
    if (lower.includes('invalid login')) return 'Incorrect email or password.';
    if (lower.includes('email') && lower.includes('not confirmed')) return 'Please confirm your email before signing in.';
    return message;
  };

  const isStrongPassword = (value: string) => /[A-Za-z]/.test(value) && /[^A-Za-z0-9\s]/.test(value);

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
        setAuthError(normalizeAuthError(error.message));
      } else {
        setAuthError('An unknown error occurred.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResetRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setAuthError(null);
    setAuthNotice(null);
    try {
      const targetEmail = (resetEmail || email).trim();
      if (!targetEmail) {
        setAuthError('Please enter your email.');
        return;
      }
      const { error } = await supabase.auth.resetPasswordForEmail(targetEmail, {
        redirectTo: `${window.location.origin}/auth/reset`
      });
      if (error) throw error;
      setAuthNotice('Password reset link sent. Check your email.');
      setResetEmail(targetEmail);
    } catch (error) {
      if (error instanceof Error) {
        setAuthError(normalizeAuthError(error.message));
      } else {
        setAuthError('An unknown error occurred.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setAuthError(null);
    setAuthNotice(null);
    try {
      if (!isStrongPassword(resetPassword)) {
        setAuthError('Password must include at least one letter and one symbol.');
        return;
      }
      if (resetPassword !== resetConfirm) {
        setAuthError('Passwords do not match.');
        return;
      }
      const { error } = await supabase.auth.updateUser({ password: resetPassword });
      if (error) throw error;
      setAuthNotice('Password updated. Please sign in.');
      navigate('/login', { replace: true });
    } catch (error) {
      if (error instanceof Error) {
        setAuthError(normalizeAuthError(error.message));
      } else {
        setAuthError('An unknown error occurred.');
      }
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    await signOut();
    navigate('/', { replace: true });
    setAuthError(null);
    setAuthNotice(null);
  };

  const loginView = (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="apple-card w-full max-w-md p-10 rounded-[2rem]">
        <div className="text-center mb-8">
          <h2 className="headline-font text-3xl text-slate-900 mb-2">
            {isRegister ? 'Create your Metrovan AI account' : 'Welcome back'}
          </h2>
          <p className="text-slate-500 text-sm">Sign in to launch your studio workflow.</p>
        </div>
        {(authError || authNotice) && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs">
            {authError && <div className="text-red-500">{authError}</div>}
            {authNotice && <div className="text-emerald-600">{authNotice}</div>}
          </div>
        )}
        <form onSubmit={handleAuth} className="space-y-6">
          {isRegister && (
            <div>
              <label className="input-label">Full name</label>
              <input
                type="text"
                required
                className="input-field"
                placeholder="Enter your name"
                value={fullName}
                onChange={e => setFullName(e.target.value)}
              />
            </div>
          )}
          <div>
            <label className="input-label">Email address</label>
            <input
              type="email"
              required
              className="input-field"
              placeholder="Enter your email"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="input-label">Password</label>
            <input
              type="password"
              required
              className="input-field"
              placeholder="********"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
            {isRegister && (
              <p className="mt-2 text-[11px] text-slate-500">
                Must include at least one letter and one symbol.
              </p>
            )}
          </div>
          <button className="w-full py-4 btn-primary rounded-full text-xs font-semibold uppercase tracking-[0.2em]">
            {isRegister ? 'Create account' : 'Sign in'}
          </button>
        </form>
        <div className="mt-8 text-center text-sm text-slate-500">
          {!isRegister && (
            <button
              onClick={() => { setIsResetting(true); setAuthError(null); setAuthNotice(null); }}
              className="text-blue-600 font-semibold hover:underline"
            >
              Forgot password?
            </button>
          )}
          {isRegister ? (
            <>
              {' '}Already have an account?
              <button
                onClick={() => { setIsRegister(false); setAuthError(null); setAuthNotice(null); }}
                className="ml-1 text-blue-600 font-semibold hover:underline"
              >
                Sign in
              </button>
            </>
          ) : (
            <>
              {" Don't have an account?"}
              <button
                onClick={() => { setIsRegister(true); setAuthError(null); setAuthNotice(null); }}
                className="ml-1 text-blue-600 font-semibold hover:underline"
              >
                Create one
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );

  const resetRequestView = (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="apple-card w-full max-w-md p-10 rounded-[2rem] text-center">
        <h2 className="headline-font text-2xl text-slate-900 mb-2">Reset password</h2>
        <p className="text-sm text-slate-500 mb-8">We will send you a reset link.</p>
        {(authError || authNotice) && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-left">
            {authError && <div className="text-red-500">{authError}</div>}
            {authNotice && <div className="text-emerald-600">{authNotice}</div>}
          </div>
        )}
        <form onSubmit={handleResetRequest} className="space-y-6">
          <div>
            <label className="input-label">Email address</label>
            <input
              type="email"
              required
              className="input-field"
              placeholder="Enter your email"
              value={resetEmail || email}
              onChange={e => setResetEmail(e.target.value)}
            />
          </div>
          <button className="w-full py-4 btn-primary rounded-full text-xs font-semibold uppercase tracking-[0.2em]">
            Send reset link
          </button>
        </form>
        <div className="mt-8 text-sm text-slate-500">
          <button
            onClick={() => { setIsResetting(false); setAuthError(null); setAuthNotice(null); }}
            className="text-blue-600 font-semibold hover:underline"
          >
            Back to sign in
          </button>
        </div>
      </div>
    </div>
  );

  const authCallbackView = (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="apple-card w-full max-w-md p-10 rounded-[2rem] text-center">
        <h2 className="headline-font text-2xl text-slate-900 mb-3">Verifying email</h2>
        <p className="text-sm text-slate-500">Please wait while we confirm your account.</p>
      </div>
    </div>
  );

  const resetPasswordView = (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="apple-card w-full max-w-md p-10 rounded-[2rem]">
        <div className="text-center mb-8">
          <h2 className="headline-font text-2xl text-slate-900 mb-2">Set a new password</h2>
          <p className="text-sm text-slate-500">Choose a strong password to continue.</p>
        </div>
        {(authError || authNotice) && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs">
            {authError && <div className="text-red-500">{authError}</div>}
            {authNotice && <div className="text-emerald-600">{authNotice}</div>}
          </div>
        )}
        {!resetReady ? (
          <div className="text-center text-sm text-slate-500">Validating reset link...</div>
        ) : (
          <form onSubmit={handlePasswordUpdate} className="space-y-6">
            <div>
              <label className="input-label">New password</label>
              <input
                type="password"
                required
                className="input-field"
                placeholder="********"
                value={resetPassword}
                onChange={e => setResetPassword(e.target.value)}
              />
              <p className="mt-2 text-[11px] text-slate-500">Must include at least one letter and one symbol.</p>
            </div>
            <div>
              <label className="input-label">Confirm password</label>
              <input
                type="password"
                required
                className="input-field"
                placeholder="********"
                value={resetConfirm}
                onChange={e => setResetConfirm(e.target.value)}
              />
            </div>
            <button className="w-full py-4 btn-primary rounded-full text-xs font-semibold uppercase tracking-[0.2em]">
              Update password
            </button>
          </form>
        )}
      </div>
    </div>
  );

  const routeFallback = (
    <div className="flex-1 flex items-center justify-center py-16 text-slate-500">Loading...</div>
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

  useEffect(() => {
    if (!location.pathname.startsWith('/auth/reset')) return;
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
        if (active) setResetReady(true);
      } catch (error) {
        if (active) {
          setAuthError('Reset link is invalid or expired.');
          setResetReady(false);
        }
      }
    };
    run();
    return () => {
      active = false;
    };
  }, [location.pathname]);

  if (authLoading) return <div className="h-screen flex items-center justify-center text-slate-500">Loading...</div>;

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

  return (
    <Layout user={user} onLogout={logout} onNavigate={handleNavigate} currentView={currentView}>
      <Suspense fallback={routeFallback}>
        <Routes>
          <Route path="/" element={<Home onStart={() => navigate(user ? '/studio' : '/login')} />} />
          <Route path="/login" element={user ? <Navigate to="/studio" replace /> : (isResetting ? resetRequestView : loginView)} />
          <Route path="/auth/callback" element={authCallbackView} />
          <Route path="/auth/reset" element={resetPasswordView} />
          <Route path="/studio" element={user ? <Editor user={user} workflows={workflows} /> : <Navigate to="/login" replace />} />
          <Route path="/admin" element={user && user.isAdmin ? <Admin user={user} /> : <Navigate to={user ? '/studio' : '/login'} replace />} />
          <Route path="/pricing" element={<Pricing user={user} onStart={() => navigate(user ? '/studio' : '/login')} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  );
};

export default App;

