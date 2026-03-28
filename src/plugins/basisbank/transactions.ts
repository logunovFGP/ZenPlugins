// Transaction fetching and session-retry logic extracted from fetchApi.ts.

import { TemporaryError } from '../../errors'
import { CardTransactionRow, Session } from './models'
import { isRecord } from './utils'
import {
  BASE_RETRY_DELAY_MS,
  DEFAULT_PAGE_SIZE_GUESS,
  MAX_TRANSACTION_PAGES,
  MAX_TRANSIENT_RETRY_ATTEMPTS,
  extractArrayPayloadWithShape,
  formatCardDate,
  isDeadSessionPayload,
  isRetryableTransientError,
  sleep
} from './http'
import { authorizeIfNeeded, BasisbankAuthError, callCardModule, isBasisbankAuthError } from './auth'

// ─── Session-retry wrapper ──────────────────────────────────────────────────

// Data-importer callCardModuleWithRetry (lines 1431-1464):
// 1. Try the request.
// 2. On session errors -> re-auth and retry (max 1 session recovery).
// 3. On transient errors -> exponential backoff retry (max 4 attempts).
export async function callCardModuleWithSessionRetry (
  session: Session,
  funq: string,
  form: Record<string, string>,
  context: string
): Promise<unknown> {
  let transientAttempt = 1
  let sessionRecoveryDone = false

  while (true) {
    let shouldReauth = false
    let retryReason = 'dead-session'

    try {
      const payload = await callCardModule(funq, form)
      if (!isDeadSessionPayload(payload)) {
        return payload
      }
      shouldReauth = true
    } catch (error) {
      if (isBasisbankAuthError(error)) {
        shouldReauth = true
        retryReason = error.kind
      } else if (isRetryableTransientError(error) && transientAttempt < MAX_TRANSIENT_RETRY_ATTEMPTS) {
        // Data-importer: exponential backoff = BASE_RETRY_DELAY_MS * attempt (line 1448).
        const delayMs = BASE_RETRY_DELAY_MS * transientAttempt
        console.warn(`[basisbank] transient error while ${context} (attempt ${transientAttempt}/${MAX_TRANSIENT_RETRY_ATTEMPTS}); retrying in ${delayMs}ms`)
        await sleep(delayMs)
        transientAttempt++
        continue
      } else {
        throw error
      }
    }

    if (!shouldReauth) {
      throw new TemporaryError(`BasisBank web session expired while ${context}`)
    }

    if (sessionRecoveryDone) {
      throw new TemporaryError(`BasisBank web session expired while ${context} (after re-auth)`)
    }

    console.warn(`[basisbank] auth recovery triggered while ${context} (${retryReason}); retrying after re-auth`)
    await authorizeIfNeeded(session, { forceReauth: true })
    sessionRecoveryDone = true

    try {
      const retriedPayload = await callCardModule(funq, form)
      if (isDeadSessionPayload(retriedPayload)) {
        throw new BasisbankAuthError('dead-session', `CardModule session expired (${funq})`)
      }
      return retriedPayload
    } catch (error) {
      if (isBasisbankAuthError(error)) {
        throw new TemporaryError(`BasisBank web session expired while ${context} (after re-auth)`)
      }
      throw error
    }
  }
}

// ─── Paged transaction fetching ─────────────────────────────────────────────

export async function fetchPagedTransactions (
  session: Session,
  fromDate: Date,
  toDate: Date,
  blockedOnly: boolean
): Promise<CardTransactionRow[]> {
  const rows: CardTransactionRow[] = []
  const signatures = new Set<string>()
  const seenIds = new Set<string>()

  for (let page = 1; page <= MAX_TRANSACTION_PAGES; page++) {
    const payload = await callCardModuleWithSessionRetry(session, 'getlasttransactionlist', {
      StartDate: formatCardDate(fromDate),
      EndDate: formatCardDate(toDate),
      SearchWord: '',
      PageNumber: String(page),
      JustBlocked: blockedOnly ? '1' : '0',
      AccountIban: ''
    }, `loading ${blockedOnly ? 'pending' : 'booked'} transactions page ${page}`)

    const payloadShape = extractArrayPayloadWithShape(payload)
    const pageRows = payloadShape.rows.filter(isRecord) as CardTransactionRow[]
    if (pageRows.length === 0) {
      if (page === 1 && payload != null && !isDeadSessionPayload(payload) && !payloadShape.recognized) {
        const payloadPreview = typeof payload === 'string'
          ? payload.slice(0, 140)
          : JSON.stringify(payload).slice(0, 140)
        throw new TemporaryError(`BasisBank transactions payload format is unexpected (${blockedOnly ? 'pending' : 'booked'}). Preview: ${payloadPreview}`)
      }
      break
    }

    // Data-importer: dedup individual rows by TransactionID/TransactionReference/TransferID (lines 722-731).
    let firstId = ''
    let lastId = ''
    for (const pageRow of pageRows) {
      const rowId = String(pageRow.TransactionID ?? pageRow.TransactionReference ?? pageRow.TransferID ?? '').trim()
      if (firstId === '') {
        firstId = rowId
      }
      if (rowId !== '') {
        lastId = rowId
      }
      if (rowId !== '' && seenIds.has(rowId)) {
        continue
      }
      if (rowId !== '') {
        seenIds.add(rowId)
      }
      rows.push(pageRow)
    }

    // Data-importer: page size check BEFORE signature check (line 733).
    if (pageRows.length < DEFAULT_PAGE_SIZE_GUESS) {
      break
    }

    // Data-importer signature format: 'blocked|booked' + '|' + count + '|' + firstId + '|' + lastId (line 707-713).
    const signature = `${blockedOnly ? 'blocked' : 'booked'}|${pageRows.length}|${firstId}|${lastId}`
    if (signatures.has(signature)) {
      break
    }
    signatures.add(signature)
  }

  return rows
}
