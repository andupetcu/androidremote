import { createContext, useContext } from 'react';

export interface AuthContextType {
  token: string | null;
  username: string | null;
  isAuthenticated: boolean;
  mustChangePassword: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  clearMustChangePassword: () => void;
}

export const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

// Helper to get auth headers for fetch calls
export function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('auth_token');
  if (token) {
    return { 'Authorization': `Bearer ${token}` };
  }
  return {};
}
