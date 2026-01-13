import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase } from '../services/supabaseClient';
import { jobService } from '../services/jobService';
import { User } from '../types';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  refreshUser: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = async () => {
    try {
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      
      if (session?.user) {
        // Try to fetch profile, but fallback gracefully if it fails or if user is new
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
        } catch (error) {
          // Ignore AbortErrors that happen during rapid navigation
          if (error instanceof Error && error.name === 'AbortError') return;
          console.error('Error fetching profile:', error);
          // Still set basic user info even if profile fetch fails
          setUser({
            id: session.user.id,
            email: session.user.email || '',
            name: session.user.email?.split('@')[0] || '',
            points: 0,
            isAdmin: false
          });
        }
      } else {
        setUser(null);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      console.error('Error in refreshUser:', error);
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshUser();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (session?.user) {
        // We can optionally debounce this or just call refreshUser
        await refreshUser();
      } else {
        setUser(null);
        setLoading(false);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, refreshUser, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
