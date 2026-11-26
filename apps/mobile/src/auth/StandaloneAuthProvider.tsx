import { useEffect, useMemo, useState, type Context, type ReactNode } from 'react';
import type { AuthContextValue, MobileUser } from './AuthContext';
import { ensureDeviceId } from './deviceId';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, setMobileAuthOwner } from './authOwnerGeneration';
import { ApiError, apiFetchRaw } from '@/api/client';
import { UMEDA_LOCAL_OWNER } from '@/config/standalone';
import { getActiveSelfHostedRelay, selfHostedRelayAuthorizationFor, waitForSelfHostedRelayRoute } from '@/device-link/selfHostedRelayRouting';
import { configureStandaloneRelay } from '@/device-link/selfHostedRelay';
import { AskCardAuthContext, type AskCardAuth } from '@/session/askCardAuth';
import { i18n } from '@/i18n';

const user: MobileUser = {
  id: UMEDA_LOCAL_OWNER, name: 'Umeda', avatar: null, email: null,
  membershipKind: 'personal', membershipRole: 'owner', orgId: null, orgName: null,
  orgLogoUrl: null, passportId: '',
};
const noCloud = async (): Promise<never> => { throw new ApiError('LOCAL_MODE', 403, i18n.t('apiErrors.requestFailed')); };
const nothing = async () => {};
const noToken = async () => null;
let deviceIdentity: Promise<string> | null = null;
function localDeviceIdentity(): Promise<string> {
  return deviceIdentity ??= ensureDeviceId().catch(error => { deviceIdentity = null; throw error; });
}

/** A local data owner, not an authenticated account. Relay secrets keep the normal owner fence. */
export function StandaloneAuthProvider({ context: ContextProvider, children }: {
  context: Context<AuthContextValue | null>; children: ReactNode;
}) {
  const [failure, setFailure] = useState<Error | null>(null);
  const [state, setState] = useState({ initialized: false, deviceId: null as string | null, generation: 0 });
  useEffect(() => {
    let active = true;
    setMobileAuthOwner(UMEDA_LOCAL_OWNER, 'global');
    const owner = getMobileAuthOwner();
    void localDeviceIdentity().then(async deviceId => {
      await configureStandaloneRelay(deviceId);
      await waitForSelfHostedRelayRoute();
      if (active && isMobileAuthOwnerCurrent(owner)) setState({ initialized: true, deviceId, generation: owner.generation });
    }).catch(() => { if (active) setFailure(new Error(i18n.t('apiErrors.requestFailed'))); });
    return () => { active = false; if (isMobileAuthOwnerCurrent(owner)) setMobileAuthOwner(null); };
  }, []);
  const value = useMemo<AuthContextValue>(() => ({
    ...state, isBusy: false, isAuthenticated: false, isLocalMode: true, user,
    accountGeneration: state.generation, loginState: null, authError: null,
    accountDeletionReceipt: null, accountDeletionRestored: false,
    savedAccounts: [], accountsLoading: false, accountsError: null,
    clearAuthError() {}, consumeAccountDeletionRestored() {},
    dispatchLoginAction: noCloud, captchaChallenge: null, resolveCaptchaChallenge() {},
    completeOAuthCallback: noCloud, syncSavedAccounts: nothing, switchAccount: noCloud,
    beginAddAccount: noCloud, cancelAddAccount: nothing, logout: nothing, terminateSession: nothing,
    getAccountDeletionAvailability: noCloud, requestAccountDeletionChallenge: noCloud,
    confirmAccountDeletion: noCloud, getAccountDeletionStatus: noCloud, clearAccountDeletionReceipt: nothing,
    getAccessToken: noToken, refreshAccessToken: noToken,
    async apiFetch<T>(path: string, opts: Parameters<AuthContextValue['apiFetch']>[1]): Promise<T> {
      const owner = getMobileAuthOwner();
      const relay = getActiveSelfHostedRelay();
      if (owner.accountId !== UMEDA_LOCAL_OWNER || !relay || !path.startsWith('/api/device-link/')
        || !['relay', 'open'].includes(selfHostedRelayAuthorizationFor(opts.baseUrl)?.kind ?? '')) return noCloud();
      const assertCurrent = () => {
        if (!isMobileAuthOwnerCurrent(owner)) throw new ApiError('ACCOUNT_CHANGED', 0, i18n.t('apiErrors.requestFailed'));
        opts.assertCurrent?.();
      };
      return apiFetchRaw<T>(path, { ...opts, token: null, assertCurrent });
    },
  }), [state]);
  if (failure) throw failure;
  if (!state.initialized) return null;
  return <ContextProvider.Provider value={value}>
    <AskCardAuthContext.Provider value={value as AskCardAuth}>{children}</AskCardAuthContext.Provider>
  </ContextProvider.Provider>;
}
