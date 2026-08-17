import type { ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { JoinWithCode } from '@/features/auth/JoinWithCode';
import { Recover } from '@/features/auth/Recover';
import { RecoveryKit } from '@/features/auth/RecoveryKit';
import { SignIn } from '@/features/auth/SignIn';
import { SignUp } from '@/features/auth/SignUp';
import { PublicNote } from '@/features/share/PublicNote';
import { Workspace } from '@/features/shell/Workspace';
import { useSession } from '@/store/session';

const KIT_PATH = '/recovery-kit';

/** Anything behind this needs keys in memory, not merely a valid session. */
function RequireUnlocked({ children }: { children: ReactElement }) {
  const status = useSession((state) => state.status);
  const location = useLocation();

  if (status === 'kit') return <Navigate to={KIT_PATH} replace />;

  if (status !== 'unlocked') {
    // Carried so unlocking lands back on the note that was on screen rather than at the root.
    return (
      <Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />
    );
  }

  return children;
}

/**
 * Sends a fully unlocked user away from the entry screens. A pending recovery kit is
 * deliberately not "unlocked" yet, so the kit screen is reachable and unskippable.
 */
function RequireAnonymous({ children }: { children: ReactElement }) {
  const status = useSession((state) => state.status);

  if (status === 'kit') return <Navigate to={KIT_PATH} replace />;

  return status === 'unlocked' ? <Navigate to="/" replace /> : children;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/signin"
        element={
          <RequireAnonymous>
            <SignIn />
          </RequireAnonymous>
        }
      />
      <Route
        path="/signup"
        element={
          <RequireAnonymous>
            <SignUp />
          </RequireAnonymous>
        }
      />
      <Route
        path="/recover"
        element={
          <RequireAnonymous>
            <Recover />
          </RequireAnonymous>
        }
      />
      <Route path={KIT_PATH} element={<RecoveryKit />} />
      {/* Reachable signed in or not: whoever holds a code may still need an account. */}
      <Route path="/join" element={<JoinWithCode />} />
      {/* A public link belongs to whoever holds it, so this route knows nothing about
          sessions. The secret is in the fragment and never reaches the server. */}
      <Route path="/share" element={<PublicNote />} />
      <Route
        path="/*"
        element={
          <RequireUnlocked>
            <Workspace />
          </RequireUnlocked>
        }
      />
    </Routes>
  );
}
