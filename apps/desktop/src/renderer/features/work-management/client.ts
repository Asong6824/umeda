import type { WorkManagementRequest, WorkManagementResponse, WorkOwnerStamp } from '@cindy/maker-shared/work-management';
import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';

export function useWorkOwner(): WorkOwnerStamp {
  const { dataOwnerId, dataOwnerGeneration } = useAuth();
  return { dataOwnerId, ownerGeneration: dataOwnerGeneration };
}
export function sameWorkOwner(a: WorkOwnerStamp, b: WorkOwnerStamp): boolean {
  return a.dataOwnerId === b.dataOwnerId && a.ownerGeneration === b.ownerGeneration;
}
export function useWorkAvailability(): boolean | null {
  const owner = useWorkOwner();
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setAvailable(null);
    const api = window.electronAPI?.workManagement;
    if (api) void api.available(owner).then(value => { if (live) setAvailable(value); }).catch(() => { if (live) setAvailable(false); });
    else setAvailable(false);
    return () => { live = false; };
  }, [owner.dataOwnerId, owner.ownerGeneration]);
  return available;
}
export function useWorkAvailable(): boolean { return useWorkAvailability() === true; }
export async function requestWork(request: WorkManagementRequest, owner: WorkOwnerStamp): Promise<WorkManagementResponse> {
  return window.electronAPI.workManagement.execute(request, owner);
}
