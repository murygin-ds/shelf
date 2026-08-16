import { Navigate, useNavigate } from 'react-router-dom';

import { useSession } from '@/store/session';

import { AuthLayout } from './AuthLayout';
import { RecoveryKitPanel } from './RecoveryKitPanel';

/**
 * Its own route rather than a step inside sign-up, because the code has to survive the
 * redirect that fires the moment the session becomes usable.
 */
export function RecoveryKit() {
  const navigate = useNavigate();
  const { status, pendingRecoveryCode, acknowledgeKit } = useSession();

  if (status !== 'kit' || !pendingRecoveryCode) {
    return <Navigate to={status === 'unlocked' ? '/' : '/signin'} replace />;
  }

  return (
    <AuthLayout step="RECOVERY KIT">
      <RecoveryKitPanel
        code={pendingRecoveryCode}
        onDone={() => {
          acknowledgeKit();
          navigate('/', { replace: true });
        }}
      />
    </AuthLayout>
  );
}
