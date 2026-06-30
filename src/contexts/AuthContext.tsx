import { createContext, useContext, useEffect, useState, useRef, ReactNode } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

type AuthContextType = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  loading: true,
  signOut: async () => {},
});

export const useAuth = () => useContext(AuthContext);

/** Remove todo o cache de dados do usuário anterior do localStorage */
function clearZapmaxCache() {
  const keysToRemove = Object.keys(localStorage).filter((k) =>
    k.startsWith("zapmax_")
  );
  keysToRemove.forEach((k) => localStorage.removeItem(k));
  console.log(`[Auth] Cache limpo: ${keysToRemove.length} chave(s) removida(s)`);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const previousUserId = useRef<string | null>(null);

  useEffect(() => {
    const checkFirstAdmin = async (session: Session) => {
      try {
        await supabase.functions.invoke("check-first-admin", {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
      } catch (e) {
        console.error("check-first-admin error:", e);
      }
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const incomingUserId = session?.user?.id ?? null;

      // Limpa cache se o usuário mudou (troca de conta ou logout)
      if (previousUserId.current && previousUserId.current !== incomingUserId) {
        clearZapmaxCache();
      }
      previousUserId.current = incomingUserId;

      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      if (session && _event === "SIGNED_IN") {
        checkFirstAdmin(session);
      }
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      previousUserId.current = session?.user?.id ?? null;
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      if (session) {
        checkFirstAdmin(session);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    clearZapmaxCache();
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
