import React, { useState, useEffect } from 'react';
import Layout from './components/Layout';
import Home from './components/Home';
import Editor from './components/Editor';
import ProjectList from './components/ProjectList';
import { User, PhotoTool, Job } from './types';
import { supabase } from './services/supabaseClient';
import { jobService } from './services/jobService';

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [tools, setTools] = useState<PhotoTool[]>([]);
  const [view, setView] = useState<string>('home');
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [selectedTool, setSelectedTool] = useState<PhotoTool | null>(null);
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
          setUser({ id: session.user.id, email: session.user.email || '', name: session.user.email?.split('@')[0] || '', points: profile.points, isAdmin: profile.is_admin || false });
        } catch (e) { console.error('Failed to load profile', e); }
      }
      setLoading(false);
    };
    fetchUserAndSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session?.user) {
        setUser(null);
        return;
      }
      jobService.getProfile().then(profile => {
        setUser({ id: session.user.id, email: session.user.email || '', name: session.user.email?.split('@')[0] || '', points: profile.points, isAdmin: profile.is_admin || false });
      }).catch(e => console.error('Failed to load profile on auth change', e));
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
      const { error } = isRegister
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (isRegister) alert('Check your email for confirmation!');
      else setView('editor');
    } catch (error) {
      if (error instanceof Error) alert(error.message);
      else alert('An unknown error occurred.');
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setView('home');
  };

  const handleSelectProject = (job: Job, tool: PhotoTool) => {
    setSelectedJob(job);
    setSelectedTool(tool);
    setView('editor-detail');
  };

  if (loading) return <div className="h-screen flex items-center justify-center bg-gray-900 text-white">Loading...</div>;

  const renderContent = () => {
    switch (view) {
      case 'home':
        return <Home onStart={() => user ? setView('editor') : setView('login')} />;
      case 'login':
        return (
          <div className="flex-1 flex items-center justify-center p-6">
             {/* Login Form JSX remains the same */}
          </div>
        );
      case 'editor':
        return user ? <ProjectList user={user} tools={tools} onSelectProject={handleSelectProject} /> : null;
      case 'editor-detail':
        return user && selectedJob && selectedTool ? <Editor user={user} job={selectedJob} tool={selectedTool} onUpdateUser={setUser} /> : null;
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
