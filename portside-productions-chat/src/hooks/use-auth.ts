import { useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Prefer onAuthStateChange alone (emits INITIAL_SESSION) so a late
    // getSession() resolution cannot overwrite a just-completed sign-in.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  return {
    session,
    user: (session?.user ?? null) as User | null,
    accessToken: session?.access_token ?? null,
    loading,
    isAuthenticated: Boolean(session?.user),
    /** Apply a session returned directly from sign-in/sign-up (no reload). */
    setSession,
  };
}
