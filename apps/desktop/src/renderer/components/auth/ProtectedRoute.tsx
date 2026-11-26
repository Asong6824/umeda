import { Outlet } from 'react-router-dom';
import { AppCrashScreen } from '@/components/error/AppCrashScreen';

import { useAuth } from '@/contexts/AuthContext';

export function ProtectedRoute() {
  const { canEnterApp, isInitializing, ownerBoundaryPending, dataOwnerId } = useAuth();

  if (isInitializing || ownerBoundaryPending) return null;
  // Personal startup must fail closed without looping through the retired login route.
  if (!canEnterApp) return <AppCrashScreen message="Local identity is unavailable." />;

  // Owner changes must remount the protected tree so transient New Maker
  // drafts and other route-local state cannot leak across data namespaces.
  return <Outlet key={dataOwnerId ?? 'signed-out'} />;
}
