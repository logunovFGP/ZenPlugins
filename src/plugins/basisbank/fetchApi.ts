// Thin orchestrator — public API consumed by index.ts.
// Delegates to auth.ts, accounts.ts, and transactions.ts for implementation.

import { InvalidPreferencesError, TemporaryError } from '../../errors'
import { Auth, CardAccountRow, ParsedAccountRow, Preferences, Session, UserTransactionsResponse } from './models'
import {
  authorizeIfNeeded,
  balancePageCache,
  fetchBalancePage,
  generateDeviceId,
  isBasisbankAuthError,
  markSessionAuthorized,
  normalizeStoredDeviceId,
  parseBooleanPreference
} from './auth'
import { ensureAccountsForTransactions, mergeAccounts, normalizeAccountId, parseBalanceAccountsFromHtml, parseCardRowsPayload } from './accounts'
import { callCardModuleWithSessionRetry, fetchPagedTransactions } from './transactions'

export function initializeSession (preferences: Preferences, storedAuth?: Auth): Session {
  const login = typeof preferences.login === 'string' ? preferences.login.trim() : ''
  const password = typeof preferences.password === 'string' ? preferences.password : ''

  if (login === '' || password === '') {
    throw new InvalidPreferencesError('Enter BasisBank login and password in plugin preferences')
  }

  const deviceId = normalizeStoredDeviceId(storedAuth?.deviceId) ?? generateDeviceId()

  return {
    auth: {
      login: storedAuth?.login,
      lastSuccessfulLoginAt: storedAuth?.lastSuccessfulLoginAt,
      deviceId,
      sessionExpiresAt: typeof storedAuth?.sessionExpiresAt === 'number' ? storedAuth.sessionExpiresAt : undefined,
      trustedDeviceExpiresAt: typeof storedAuth?.trustedDeviceExpiresAt === 'number' ? storedAuth.trustedDeviceExpiresAt : undefined
    },
    deviceId,
    login,
    password,
    requestSmsCode: parseBooleanPreference(preferences.requestSmsCode, true),
    trustDevice: parseBooleanPreference(preferences.trustDevice, true)
  }
}

export async function ensureSessionReady (session: Session): Promise<void> {
  await authorizeIfNeeded(session)
}

export async function fetchUserAccounts (session: Session): Promise<ParsedAccountRow[]> {
  let balanceHtml = balancePageCache.get(session)
  if (balanceHtml == null) {
    try {
      balanceHtml = await fetchBalancePage()
      await markSessionAuthorized(session, balanceHtml)
    } catch (error) {
      if (!isBasisbankAuthError(error)) {
        throw error
      }
      balanceHtml = await authorizeIfNeeded(session, { forceReauth: true })
    }
  }
  const balanceAccounts = parseBalanceAccountsFromHtml(balanceHtml)

  let cardRows: CardAccountRow[] = []
  try {
    const cardPayload = await callCardModuleWithSessionRetry(session, 'getcardlist', {}, 'loading card accounts')
    cardRows = parseCardRowsPayload(cardPayload)
  } catch (error) {
    console.warn('[basisbank] could not load card account list', error)
  }

  return mergeAccounts(balanceAccounts, cardRows)
}

export async function fetchUserTransactions (
  session: Session,
  fromDate: Date,
  toDate: Date,
  accounts: ParsedAccountRow[]
): Promise<UserTransactionsResponse> {
  const booked = await fetchPagedTransactions(session, fromDate, toDate, false)
  const pending = await fetchPagedTransactions(session, fromDate, toDate, true)

  const enrichedAccounts = ensureAccountsForTransactions(accounts, [...booked, ...pending])

  const hasMeaningfulAccountIds = enrichedAccounts.some(account => normalizeAccountId(account) !== '')
  if (!hasMeaningfulAccountIds) {
    throw new TemporaryError('BasisBank account list is empty after authorization')
  }

  return { booked, pending, accounts: enrichedAccounts }
}
