import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';

import App from './App';

import './main.css';

/**
 * Server state lives in TanStack Query; this client is its cache.
 *
 * Queries are keyed by entity, filter and sort order, which is what makes
 * stale responses structurally impossible — a slow reply lands in the cache
 * entry for the key it was asked with, not in whatever the screen shows now.
 * The hand-rolled guards this replaced took three attempts to get right; the
 * component key in App.tsx now resets only UI state.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // One retry, not three: against a local backend a real failure should
      // surface in about a second, not after a silent half-minute of backoff.
      retry: 1,
      // Reference data does not change under the reader mid-session; the app
      // refetches after its own writes instead (see onSaved).
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
);
