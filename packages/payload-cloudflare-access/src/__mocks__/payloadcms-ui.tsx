// Browser-test stand-in for `@payloadcms/ui` (aliased in vitest.config.ts).
// Only the exports used by the client components of this package.
import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

export const Logout = () => <span data-testid="payload-logout" />;

export const LogOutIcon = () => <svg data-testid="payload-logout-icon" aria-hidden="true" />;

// Returns the translation key itself, so tests can assert which key a component asks for.
export const useTranslation = () => ({ t: (key: string): string => key });

// Same props as the real AuthProvider, so tests render it with the real `ClientUser` type.
const AuthContext = createContext<{ user: unknown }>({ user: null });

export const AuthProvider = ({ children, user = null }: { children: ReactNode; user?: unknown }) => {
  const value = useMemo(() => ({ user }), [user]);
  return <AuthContext value={value}>{children}</AuthContext>;
};

export const useAuth = () => useContext(AuthContext);
