import { AccountOrCard, AccountType, ExtendedTransaction } from '../../types/zenmoney'
import { CardTransactionRow, ParsedAccountRow } from './models'
import { uniqueStrings, parseNumber, normalizeCurrencyToken, trimOrUndefined, isAmountObject } from './utils'

function parseDateFromParts (
  dayRaw: string,
  monthRaw: string,
  yearRaw: string,
  hourRaw?: string,
  minuteRaw?: string,
  secondRaw?: string
): Date | null {
  const day = Number(dayRaw)
  const month = Number(monthRaw)
  const year = Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw)
  const hour = Number(hourRaw ?? '0')
  const minute = Number(minuteRaw ?? '0')
  const second = Number(secondRaw ?? '0')

  const date = new Date(year, month - 1, day, hour, minute, second, 0)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }
  return date
}

/**
 * Format a Date as YYYY-MM-DD string (matching data-importer's toDateString).
 */
function formatDateOnly (date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function parseTransactionDate (value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }

  if (typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }

  if (typeof value !== 'string') {
    return null
  }

  const raw = value.replace(/\u00a0/g, ' ').trim()
  if (raw === '') {
    return null
  }

  const msSinceEpoch = raw.match(/^\/Date\((\d+)\)\/$/)
  if (msSinceEpoch != null) {
    const date = new Date(Number(msSinceEpoch[1]))
    return Number.isNaN(date.getTime()) ? null : date
  }

  const withTime = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (withTime != null) {
    return parseDateFromParts(withTime[1], withTime[2], withTime[3], withTime[4], withTime[5], withTime[6])
  }

  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function toMovementId (value: unknown): string | null {
  if (value == null) {
    return null
  }
  const asString = String(value).trim()
  return asString === '' ? null : asString
}

/**
 * Stable fallback ID when TransactionID/TransferID/TransactionReference are all missing.
 * Matches data-importer: hash of [baseAccountId, amount, date, description].
 * Uses base account ID without #currency suffix for cross-import stability.
 */
function hashFallbackId (accountId: string, amount: number, dateIso: string, description: string): string {
  const baseAccountId = accountId.includes('#') ? accountId.slice(0, accountId.indexOf('#')) : accountId
  const payload = JSON.stringify([baseAccountId, String(amount), dateIso, description])
  // FNV-1a 32-bit hash — sufficient for dedup keys within a sync batch.
  let hash = 0x811c9dc5
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// Build index mapping sync IDs to *all* matching accounts.
// When multi-currency splitting creates IBAN#EUR and IBAN#USD, the base IBAN
// maps to both. resolveAccount() picks the correct one by currency.
function buildAccountIndex (accounts: AccountOrCard[]): Map<string, AccountOrCard[]> {
  const map = new Map<string, AccountOrCard[]>()
  for (const account of accounts) {
    const keys = [account.id, ...account.syncIds]
    for (const key of keys) {
      const normalized = key.trim()
      if (normalized === '') {
        continue
      }
      for (const variant of [normalized, normalized.toUpperCase()]) {
        const existing = map.get(variant)
        if (existing != null) {
          if (!existing.includes(account)) {
            existing.push(account)
          }
        } else {
          map.set(variant, [account])
        }
      }
    }
  }
  return map
}

// Resolve the best account for a transaction from the multi-account index.
// When currency-scoped accounts exist (IBAN#EUR, IBAN#USD), pick the one
// whose instrument matches the transaction currency.
function resolveAccount (
  accountIndex: Map<string, AccountOrCard[]>,
  accountIban: string,
  transactionCurrency: string | undefined
): AccountOrCard | undefined {
  const candidates = accountIndex.get(accountIban) ?? accountIndex.get(accountIban.toUpperCase())
  if (candidates == null || candidates.length === 0) {
    return undefined
  }
  if (candidates.length === 1) {
    return candidates[0]
  }
  if (transactionCurrency != null && transactionCurrency !== '') {
    const matched = candidates.find(a => a.instrument === transactionCurrency)
    if (matched != null) {
      return matched
    }
  }
  return candidates.find(a => !a.id.includes('#')) ?? candidates[0]
}

export function convertAccount (row: ParsedAccountRow): AccountOrCard {
  const instrument = trimOrUndefined(row.instrument) ?? 'GEL'
  const accountType = row.isCard ? AccountType.ccard : AccountType.checking

  return {
    id: row.id,
    type: accountType,
    title: trimOrUndefined(row.title) ?? row.id,
    instrument,
    syncIds: uniqueStrings([row.id, row.iban, ...row.syncIds]),
    balance: row.balance,
    available: row.available
  }
}

export function convertAccounts (rows: ParsedAccountRow[]): AccountOrCard[] {
  const byId = new Map<string, AccountOrCard>()
  for (const row of rows) {
    const converted = convertAccount(row)
    byId.set(converted.id, converted)
  }
  return [...byId.values()]
}

// ─── Row classification ────────────────────────────────────────────────────────
// Data-importer's isWebRow: presence of CardModule-style PascalCase fields.
function isWebRow (row: CardTransactionRow): boolean {
  return row.TransactionID !== undefined ||
    row.AccountIban !== undefined ||
    row.DocDate !== undefined ||
    row.Ccy !== undefined ||
    row.TransferID !== undefined
}

// ─── Amount extraction with credit/debit indicator ─────────────────────────────
// Matching data-importer's normalizeTransaction/normalizeWebTransaction sign logic.
function extractAmount (row: CardTransactionRow): number | null {
  let raw: number | null

  if (isWebRow(row)) {
    // CardModule format: flat Amount field.
    raw = parseNumber(row.Amount)
  } else {
    // PSD2 API format: nested transactionAmount.amount or amount.amount or flat amount.
    const nested = row.transactionAmount?.amount ??
      (isAmountObject(row.amount) ? row.amount.amount : row.amount)
    raw = parseNumber(nested)
  }

  if (raw == null || raw === 0) {
    return raw
  }

  // Apply credit/debit indicator (data-importer lines 1857-1863 / 1903-1909).
  const indicator = String(
    row.CreditDebitIndicator ?? row.creditDebitIndicator ?? row.debitCreditIndicator ?? ''
  ).toUpperCase()

  if (indicator.includes('DBIT') || indicator.includes('DEBIT')) {
    raw = -1 * Math.abs(raw)
  } else if (indicator.includes('CRDT') || indicator.includes('CREDIT')) {
    raw = Math.abs(raw)
  }

  return raw
}

// ─── Date extraction with fallback chain ───────────────────────────────────────
// Matching data-importer: Web → DocDate > DateTime > Date > today ;
//                         PSD2 -> bookingDateTime > bookingDate > valueDate > transactionDate > date > today
// Data-importer falls back to date('Y-m-d') (today) for unparseable dates (lines 1869, 1914).
function extractDate (row: CardTransactionRow): Date {
  if (isWebRow(row)) {
    return parseTransactionDate(row.DocDate) ??
      parseTransactionDate(row.DateTime) ??
      parseTransactionDate(row.Date) ??
      todayDate()
  }
  return parseTransactionDate(row.bookingDateTime) ??
    parseTransactionDate(row.bookingDate) ??
    parseTransactionDate(row.valueDate) ??
    parseTransactionDate(row.transactionDate) ??
    parseTransactionDate(row.date) ??
    todayDate()
}

function todayDate (): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
}

// ─── Description extraction with PSD2 structured fields ────────────────────────
// Matching data-importer: remittanceInformationUnstructuredArray (joined) >
//   remittanceInformationUnstructured > additionalInformation > description
function extractDescription (row: CardTransactionRow): string {
  if (!isWebRow(row)) {
    // PSD2 path.
    // Data-importer line 1872: trim(implode(' ', array)) — joins raw elements, trims outer.
    if (Array.isArray(row.remittanceInformationUnstructuredArray) && row.remittanceInformationUnstructuredArray.length > 0) {
      const joined = row.remittanceInformationUnstructuredArray.map(s => String(s)).join(' ').trim()
      if (joined !== '') {
        return joined
      }
    }
    // Data-importer line 1875: $row['remittanceInformationUnstructured'] ?? $row['additionalInformation'] ?? $row['description']
    // Note: data-importer uses lowercase 'description' as final PSD2 fallback (not PascalCase 'Description').
    return trimOrUndefined(row.remittanceInformationUnstructured) ??
      trimOrUndefined(row.additionalInformation) ??
      trimOrUndefined(row.description) ??
      trimOrUndefined(row.Description) ??
      ''
  }
  return trimOrUndefined(row.Description) ?? ''
}

// ─── Merchant / counterparty extraction ────────────────────────────────────────
// Matching data-importer: creditorName > debtorName > counterpartyName > Description > CardPan
function extractMerchantTitle (row: CardTransactionRow): string | undefined {
  if (!isWebRow(row)) {
    return trimOrUndefined(row.creditorName) ??
      trimOrUndefined(row.debtorName) ??
      trimOrUndefined(row.counterpartyName)
  }
  // For CardModule rows, Description doubles as merchant.
  // CardPan (masked card number) is last resort.
  return trimOrUndefined(row.Description) ?? trimOrUndefined(row.CardPan)
}

// ─── Account ID resolution ─────────────────────────────────────────────────────
// Matching data-importer: AccountIban > MainAccountID > AccountIbanEncrypted > accountId > sourceAccountId.
function extractAccountIban (row: CardTransactionRow): string | undefined {
  return trimOrUndefined(row.AccountIban) ??
    (row.MainAccountID != null ? trimOrUndefined(String(row.MainAccountID)) : undefined) ??
    trimOrUndefined(row.AccountIbanEncrypted) ??
    trimOrUndefined(row.accountId) ??
    trimOrUndefined(row.sourceAccountId)
}

// ─── External ID with full fallback chain ──────────────────────────────────────
// Data-importer web: TransactionID > TransactionReference > TransferID > hash
// Data-importer PSD2: transactionId > entryReference > internalTransactionId > hash
function extractMovementId (row: CardTransactionRow, accountId: string, amount: number, dateIso: string, description: string): string {
  if (isWebRow(row)) {
    return toMovementId(row.TransactionID) ??
      trimOrUndefined(row.TransactionReference) ??
      toMovementId(row.TransferID) ??
      hashFallbackId(accountId, amount, dateIso, description)
  }
  // PSD2 path: data-importer does NOT fall through to CardModule-style fields.
  return toMovementId(row.transactionId) ??
    trimOrUndefined(row.entryReference) ??
    toMovementId(row.internalTransactionId) ??
    hashFallbackId(accountId, amount, dateIso, description)
}

// ─── Cross-account transfer grouping ──────────────────────────────────────────
// Extract a stable group key for cross-account transfer matching.
// When the same real-world transfer appears on both sender and receiver accounts,
// both sides share the same TransferID (web) or transactionId (PSD2).
// ZenMoney uses groupKeys to auto-merge them.
// Returns null for non-transfer transactions (no grouping).
function extractGroupKey (row: CardTransactionRow): string | null {
  if (isWebRow(row)) {
    // Web path: TransferID is the canonical transfer identifier.
    // TransactionID is per-account, TransferID is per-transfer.
    const transferId = row.TransferID != null ? String(row.TransferID).trim() : ''
    if (transferId !== '') {
      return transferId
    }
    // Fallback: TransactionReference may link both sides.
    const txnRef = trimOrUndefined(row.TransactionReference)
    if (txnRef != null) {
      return txnRef
    }
    return null
  }
  // PSD2 path: transactionId is shared across both sides of a transfer.
  const psd2Id = trimOrUndefined(row.transactionId)
  if (psd2Id != null) {
    return psd2Id
  }
  // entryReference may also link both sides.
  const entryRef = trimOrUndefined(row.entryReference)
  if (entryRef != null) {
    return entryRef
  }
  return null
}

// ─── Main conversion ───────────────────────────────────────────────────────────

function convertTransaction (
  row: CardTransactionRow,
  hold: boolean,
  accountIndex: Map<string, AccountOrCard[]>
): ExtendedTransaction | null {
  const accountIban = extractAccountIban(row)
  if (accountIban == null) {
    return null
  }

  // Resolve transaction currency early so we can route to the correct
  // currency-scoped account (matching data-importer's filterTransactions
  // which filters by expectedCurrency per scoped account).
  const rawCurrency = extractTransactionCurrency(row)
  const account = resolveAccount(accountIndex, accountIban, rawCurrency)
  if (account == null || ZenMoney.isAccountSkipped(account.id)) {
    return null
  }

  const amount = extractAmount(row)
  if (amount == null || amount === 0) {
    return null
  }

  const date = extractDate(row)

  const instrument = rawCurrency ?? account.instrument
  const description = extractDescription(row)
  // Use Y-m-d format for hash inputs, matching data-importer's normalizeDate output.
  const dateForHash = formatDateOnly(date)
  const movementId = extractMovementId(row, account.id, amount, dateForHash, description)

  const merchantTitle = extractMerchantTitle(row)
  // Avoid setting merchant to the same text as the comment to reduce noise.
  const merchant = merchantTitle != null && merchantTitle !== description
    ? { fullTitle: merchantTitle, mcc: null, location: null } as const
    : null

  // Cross-account transfer dedup: when TransferID (web) or transactionId (PSD2)
  // is present, use it as groupKey so ZenMoney auto-merges both sides of a transfer.
  // Pattern: Credo-GE, TBC-GE, Bank of Georgia all use this mechanism.
  const groupKey = extractGroupKey(row)

  return {
    hold,
    date,
    movements: [
      {
        id: movementId,
        account: { id: account.id },
        invoice: instrument === account.instrument ? null : { sum: amount, instrument },
        sum: amount,
        fee: 0
      }
    ],
    merchant,
    comment: description !== '' ? description : null,
    groupKeys: [groupKey]
  }
}

export function convertTransactions (
  booked: CardTransactionRow[],
  pending: CardTransactionRow[],
  accounts: AccountOrCard[],
  fromDate?: Date,
  toDate?: Date
): ExtendedTransaction[] {
  const accountIndex = buildAccountIndex(accounts)
  const out: ExtendedTransaction[] = []
  const dedupe = new Set<string>()
  // Secondary dedup (data-importer's deduplicateByDescriptionDate).
  const contentDedupe = new Map<string, string>()

  // Date boundaries for filtering (matching data-importer's filterTransactions
  // which enforces notBefore/notAfter on every transaction).
  const fromMs = fromDate != null ? fromDate.getTime() : undefined
  const toMs = toDate != null ? toDate.getTime() : undefined

  for (const [rows, hold] of [[booked, false], [pending, true]] as const) {
    for (const row of rows) {
      const converted = convertTransaction(row, hold, accountIndex)
      if (converted == null) {
        continue
      }

      // Date range enforcement (matching data-importer's filterTransactions).
      const txnMs = converted.date.getTime()
      if (fromMs != null && txnMs < fromMs) {
        continue
      }
      if (toMs != null && txnMs > toMs) {
        continue
      }

      const movement = converted.movements[0]
      const movementAccountId = typeof movement.account === 'object' && movement.account != null && 'id' in movement.account
        ? String(movement.account.id)
        : ''
      const movementSum = movement.sum == null ? '' : String(movement.sum)
      // Use Y-m-d date only (not full ISO) to avoid millisecond drift causing duplicates.
      // Matches the secondary dedup's date precision.
      const dateOnly = formatDateOnly(converted.date)
      const dedupeKey = `${movement.id ?? ''}|${movementAccountId}|${movementSum}|${dateOnly}|${String(hold)}`
      if (dedupe.has(dedupeKey)) {
        continue
      }

      // Secondary dedup by content: description + date + amount.
      // Data-importer uses toDateString() (Y-m-d only) for the content key, NOT full ISO timestamp.
      // If both have distinct non-empty movement IDs, they are genuinely different transactions.
      const contentKey = `${movementAccountId}|${converted.comment ?? ''}|${dateOnly}|${movementSum}`
      const previousId = contentDedupe.get(contentKey)
      if (previousId !== undefined) {
        const currentId = movement.id ?? ''
        // Only filter when BOTH IDs are empty (truly ambiguous) or IDs match exactly.
        // When one has an ID and the other doesn't, they may be different transactions.
        if ((currentId === '' && previousId === '') || currentId === previousId) {
          continue
        }
      }
      contentDedupe.set(contentKey, movement.id ?? '')

      dedupe.add(dedupeKey)
      out.push(converted)
    }
  }

  out.sort((left, right) => left.date.getTime() - right.date.getTime())
  return out
}

// ─── Multi-currency helpers ───────────────────────────────────────────────────

// Extract all plausible account identifiers from a transaction row
// (matching data-importer's collectAccountCurrencies which checks
// AccountIban, AccountIbanEncrypted, MainAccountID).
function extractTransactionAccountKeys (txn: CardTransactionRow): string[] {
  const candidates: Array<string | undefined> = [
    txn.AccountIban,
    txn.AccountIbanEncrypted,
    txn.MainAccountID != null ? String(txn.MainAccountID) : undefined,
    txn.accountId,
    txn.sourceAccountId
  ]
  return candidates
    .filter((v): v is string => v != null && v.trim() !== '')
    .map(v => v.trim())
}

// Extract currency from a transaction row using the full fallback chain
// (Ccy, then PSD2 nested fields) — matching normalizeTransactionCurrency
// but without an account fallback (returns undefined when unknown).
function extractTransactionCurrency (txn: CardTransactionRow): string | undefined {
  const direct = normalizeCurrencyToken(String(txn.Ccy ?? ''))
  if (direct != null) {
    return direct
  }
  const nested = txn.transactionAmount?.currency ??
    (isAmountObject(txn.amount) ? txn.amount.currency : undefined) ??
    txn.currency
  if (nested != null) {
    return normalizeCurrencyToken(String(nested))
  }
  return undefined
}

// ─── Multi-currency account splitting ──────────────────────────────────────────
// Matching data-importer's splitAccountsByCurrency: detects accounts with transactions
// in multiple currencies and creates scoped accounts (baseId#CURRENCY) for each.

export function splitAccountsByCurrency (
  accounts: ParsedAccountRow[],
  allTransactions: CardTransactionRow[]
): ParsedAccountRow[] {
  // Collect all currencies seen per account (by sync ID match).
  const accountCurrencies = new Map<string, Set<string>>()

  const syncIdToAccountId = new Map<string, string>()
  for (const account of accounts) {
    accountCurrencies.set(account.id, new Set(account.instrument !== '' ? [account.instrument] : []))
    syncIdToAccountId.set(account.id, account.id)
    syncIdToAccountId.set(account.id.toUpperCase(), account.id)
    for (const syncId of account.syncIds) {
      syncIdToAccountId.set(syncId, account.id)
      syncIdToAccountId.set(syncId.toUpperCase(), account.id)
    }
  }

  for (const txn of allTransactions) {
    // Match transaction to account using all identifier fields
    // (data-importer checks AccountIban, AccountIbanEncrypted, MainAccountID).
    const keys = extractTransactionAccountKeys(txn)
    let matchedAccountId: string | undefined
    for (const key of keys) {
      matchedAccountId = syncIdToAccountId.get(key) ?? syncIdToAccountId.get(key.toUpperCase())
      if (matchedAccountId != null) break
    }
    if (matchedAccountId == null) continue

    // Use full currency extraction chain (Ccy + PSD2 nested fields).
    const ccy = extractTransactionCurrency(txn)
    if (ccy != null) {
      accountCurrencies.get(matchedAccountId)?.add(ccy)
    }
  }

  const result: ParsedAccountRow[] = []
  for (const account of accounts) {
    const currencies = accountCurrencies.get(account.id)
    if (currencies == null || currencies.size <= 1) {
      result.push(account)
      continue
    }

    // Multi-currency: create scoped accounts.
    for (const ccy of currencies) {
      const scopedId = `${account.id}#${ccy}`
      result.push({
        ...account,
        id: scopedId,
        instrument: ccy,
        title: `${account.title} (${ccy})`,
        syncIds: uniqueStrings([scopedId, account.id, account.iban, ...account.syncIds])
      })
    }
  }

  return result
}
