// Account parsing, merging, and enrichment extracted from fetchApi.ts.
// Pure functions — no HTTP calls, no side effects.

import cheerio from 'cheerio'
import { CardAccountRow, CardTransactionRow, ParsedAccountRow } from './models'
import { extractArrayPayload } from './http'
import { CURRENCY_SYMBOLS, isRecord, KNOWN_CURRENCIES_SET, normalizeWhitespace, parseNumber, uniqueStrings } from './utils'

export function parseCurrencyFromText (text: string): string | undefined {
  // Check for currency symbols first (data-importer handles ₾, €, $).
  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (text.includes(symbol)) {
      return code
    }
  }

  const matches = text.match(/\b[A-Z]{3}\b/g)
  if (matches == null) {
    return undefined
  }

  for (const candidate of matches) {
    if (KNOWN_CURRENCIES_SET.has(candidate)) {
      return candidate
    }
  }

  // Only return known currencies — arbitrary 3-letter codes (e.g. "THE", "FOR") are not currencies.
  return undefined
}

// Data-importer parseAmounts(): regex is /-?\d[\d\s,.()]+/u which also captures
// parenthesized negatives like "(1,234.56)" and comma-separated thousands.
// The data-importer also filters out zero amounts (abs($parsed) > 0.0).
export function parseRowAmounts (rowTextParts: string[]): number[] {
  const amounts: number[] = []
  const regex = /-?\d[\d\s,.()]+/g

  for (const part of rowTextParts) {
    const partMatches = part.match(regex)
    if (partMatches == null) {
      continue
    }

    for (const match of partMatches) {
      const parsed = parseNumber(match)
      if (parsed != null && Math.abs(parsed) > 0) {
        amounts.push(parsed)
      }
    }
  }

  return amounts
}

export function mapCardAccount (row: CardAccountRow): ParsedAccountRow | null {
  const iban = row.AccountIban != null && row.AccountIban.trim() !== '' ? row.AccountIban.trim() : undefined
  const encrypted = row.AccountIbanEncrypted != null && row.AccountIbanEncrypted.trim() !== ''
    ? row.AccountIbanEncrypted.trim()
    : undefined
  const mainAccountId = row.MainAccountID != null ? String(row.MainAccountID) : undefined

  const id = iban ?? encrypted ?? (mainAccountId != null ? `bb-card-${mainAccountId}` : undefined)
  if (id == null) {
    return null
  }

  // Data-importer: CurrencyCode::normalizeOrEmpty returns '' for unrecognized currencies.
  // Do NOT default to 'GEL' — leave empty to allow enrichment from transactions later.
  const rawCurrency = row.MainCCy ?? (Array.isArray(row.CcyArray) ? row.CcyArray.find(item => item != null && item.trim() !== '') : undefined) ?? ''
  const currency = rawCurrency.trim().toUpperCase() !== '' && KNOWN_CURRENCIES_SET.has(rawCurrency.trim().toUpperCase())
    ? rawCurrency.trim().toUpperCase()
    : ''
  const title = row.AccountName ?? row.ProductName ?? row.AccountDescription ?? iban ?? id
  const amount = parseNumber(row.Amount)

  return {
    id,
    title,
    iban,
    // Data-importer: normalizeCardAccount includes 'bban' => $mainAccountId (line 537).
    bban: mainAccountId,
    instrument: currency,
    balance: amount,
    available: amount,
    isCard: true,
    syncIds: uniqueStrings([id, iban, encrypted, mainAccountId])
  }
}

export function parseBalanceAccountsFromHtml (balanceHtml: string): ParsedAccountRow[] {
  const $ = cheerio.load(balanceHtml)
  const parsed: ParsedAccountRow[] = []

  $('a[href*="/Accounts/Statement/Statement.aspx?ID="]').each((_, element) => {
    const link = $(element)
    const href = link.attr('href') ?? ''
    const idMatch = href.match(/[?&]ID=(\d+)/i)
    if (idMatch == null) {
      return
    }

    const accountId = idMatch[1]
    const row = link.closest('tr')
    const rowTextParts: string[] = row
      .find('td')
      .map((__, td) => normalizeWhitespace($(td).text()))
      .get()
      .filter(text => text !== '')
    const rowText = normalizeWhitespace(row.text())
    const linkText = normalizeWhitespace(link.text())

    // Data-importer: extractIban() uses combinedText (rawTitle + row cells) with case-insensitive
    // regex and applies strtoupper to the result. Match that: search combinedText, uppercase output.
    const combinedText = `${linkText} ${rowText}`
    const ibanMatch = combinedText.match(/\b[A-Z]{2}\d{2}[A-Z0-9]{8,}/i)
    const iban = ibanMatch?.[0]?.toUpperCase()

    const rawTitle = rowTextParts.find(part => {
      return part !== linkText && !/[A-Z]{2}\d{2}[A-Z0-9]{8,}/i.test(part) && parseCurrencyFromText(part) == null && parseNumber(part) == null
    })

    const title = rawTitle ?? (linkText !== '' ? linkText : `BasisBank account ${accountId}`)
    const amounts = parseRowAmounts(rowTextParts.length > 0 ? rowTextParts : [combinedText])
    // Data-importer: extractCurrency returns null (normalizeOrEmpty -> '') when no currency found.
    // Do NOT default to 'GEL' here — data-importer leaves it empty and resolves later via enrichment.
    const currency = parseCurrencyFromText(combinedText) ?? ''
    // Data-importer: balance = amounts[count-1], available = amounts[count-2] ?? balance.
    const balance = amounts.length > 0 ? amounts[amounts.length - 1] : null
    const available = amounts.length > 1 ? amounts[amounts.length - 2] : balance
    // Data-importer: checks combinedText for card keywords (line 252).
    const isCard = /\b(card|mastercard|visa)\b/i.test(combinedText)

    // Data-importer: 'id' => '' !== $iban ? $iban : (string)$statementId (line 261).
    // Uses raw statementId as fallback, NOT bb-account-{id}. The bb-account- prefix goes only into syncIds.
    parsed.push({
      id: iban ?? accountId,
      title,
      iban,
      bban: accountId,
      instrument: currency,
      balance,
      available,
      isCard,
      syncIds: uniqueStrings([iban, accountId, `bb-account-${accountId}`])
    })
  })

  // Data-importer: extractStatementIdsFromHtml runs a global regex on the full HTML,
  // then appends synthetic accounts for any statement IDs NOT already represented in parsed[].
  // This happens REGARDLESS of whether parsed is empty — it fills gaps (lines 291-329).
  {
    const fallbackIds = new Set<string>()
    const regex = /Accounts\/Statement\/Statement\.aspx\?ID=(\d+)/gi
    let match = regex.exec(balanceHtml)
    while (match != null) {
      fallbackIds.add(match[1])
      match = regex.exec(balanceHtml)
    }

    const existingIds = new Set(parsed.map(account => account.id))
    const existingBbans = new Set(parsed.map(account => account.bban).filter(Boolean))

    for (const accountId of fallbackIds) {
      // Data-importer checks both raw statementId and existing account IDs.
      if (existingIds.has(accountId) || existingBbans.has(accountId)) {
        continue
      }
      // Data-importer: synthetic ID is raw statementId, NOT bb-account-{id} (line 307).
      // Data-importer: synthetic currency is '' (empty), NOT 'GEL' (line 314).
      parsed.push({
        id: accountId,
        title: `BasisBank account ${accountId}`,
        bban: accountId,
        instrument: '',
        balance: null,
        available: null,
        isCard: false,
        syncIds: [accountId, `bb-account-${accountId}`]
      })
    }
  }

  // Data-importer: mergeDuplicateBalanceRows (lines 449-488) merges duplicates by ID.
  // Card accounts take priority over non-card for field values; syncIds, extras merged.
  const dedupe = new Map<string, ParsedAccountRow>()
  for (const account of parsed) {
    const existing = dedupe.get(account.id)
    if (existing == null) {
      dedupe.set(account.id, account)
      continue
    }
    // Merge: card accounts take priority — create new object instead of mutating.
    const primary = account.isCard && !existing.isCard ? account : existing
    const secondary = primary === account ? existing : account
    const merged: ParsedAccountRow = {
      ...primary,
      iban: primary.iban ?? secondary.iban,
      bban: primary.bban ?? secondary.bban,
      title: (primary.title === '' || primary.title == null) && secondary.title !== '' ? secondary.title : primary.title,
      balance: primary.balance ?? secondary.balance,
      available: primary.available ?? secondary.available,
      instrument: (primary.instrument === '' || primary.instrument == null) && secondary.instrument !== '' ? secondary.instrument : primary.instrument,
      syncIds: uniqueStrings([...primary.syncIds, ...secondary.syncIds]),
      isCard: primary.isCard || secondary.isCard
    }
    dedupe.set(account.id, merged)
  }

  return [...dedupe.values()]
}

export function mergeAccounts (balanceAccounts: ParsedAccountRow[], cardRows: CardAccountRow[]): ParsedAccountRow[] {
  const dedupe = new Map<string, ParsedAccountRow>()
  for (const account of balanceAccounts) {
    dedupe.set(account.id, account)
  }

  for (const row of cardRows) {
    const mapped = mapCardAccount(row)
    if (mapped == null) {
      continue
    }

    const existingEntry = [...dedupe.entries()].find(([, account]) => {
      if (account.id === mapped.id) {
        return true
      }
      return mapped.syncIds.some(syncId => account.syncIds.includes(syncId))
    })

    if (existingEntry == null) {
      dedupe.set(mapped.id, mapped)
      continue
    }

    const [existingKey, existing] = existingEntry

    // Data-importer mergeAccountRows (lines 600-638):
    // - Replaces existing ID with card ID when they differ.
    // - Updates name, balance, available, currency, iban, bban from card row when card has non-empty values.
    // - Merges syncIds and sets isCard = true if either is a card.
    let mergedSyncIds = uniqueStrings([...existing.syncIds, ...mapped.syncIds])
    let mergedId = existing.id

    // Data-importer: if card ID differs, add the old ID to syncIds and replace with card ID (lines 604-609).
    if (mapped.id !== existing.id) {
      mergedSyncIds = uniqueStrings([...mergedSyncIds, existing.id])
      mergedId = mapped.id
    }

    const merged: ParsedAccountRow = {
      ...existing,
      id: mergedId,
      title: mapped.title != null && mapped.title !== '' ? mapped.title : existing.title,
      balance: mapped.balance ?? existing.balance,
      available: mapped.available ?? existing.available,
      instrument: mapped.instrument != null && mapped.instrument !== '' ? mapped.instrument : existing.instrument,
      iban: mapped.iban != null && mapped.iban !== '' ? mapped.iban : existing.iban,
      bban: mapped.bban != null && mapped.bban !== '' ? mapped.bban : existing.bban,
      isCard: existing.isCard || mapped.isCard,
      syncIds: mergedSyncIds
    }

    // Remove old key if the ID changed, then insert under the new ID.
    if (mergedId !== existingKey) {
      dedupe.delete(existingKey)
    }
    dedupe.set(merged.id, merged)
  }

  return [...dedupe.values()]
}

export function parseCardRowsPayload (payload: unknown): CardAccountRow[] {
  return extractArrayPayload(payload).filter(isRecord) as CardAccountRow[]
}

export function normalizeAccountId (account: ParsedAccountRow): string {
  if (account.iban != null && account.iban !== '') {
    return account.iban
  }
  return account.id
}

// Data-importer ensureAccountsForTransactions (GetAccountsRequest lines 2191-2265):
// Checks AccountIban, AccountIbanEncrypted, MainAccountID AND bb-account-{MainAccountID} as identity candidates.
// Uses normalizeAccountKey (case-insensitive, whitespace-stripped) for matching.
// Currency defaults to '' (empty) not 'GEL'.
export function normalizeAccountKey (value: string): string {
  return value.trim().replace(/\s/g, '').toUpperCase()
}

export function ensureAccountsForTransactions (accounts: ParsedAccountRow[], transactions: CardTransactionRow[]): ParsedAccountRow[] {
  const known = new Map<string, boolean>()
  for (const account of accounts) {
    known.set(normalizeAccountKey(account.id), true)
    for (const syncId of account.syncIds) {
      known.set(normalizeAccountKey(syncId), true)
    }
  }

  const additions: ParsedAccountRow[] = []

  for (const transaction of transactions) {
    const accountIban = transaction.AccountIban != null ? transaction.AccountIban.trim() : ''
    const encryptedIban = transaction.AccountIbanEncrypted != null ? transaction.AccountIbanEncrypted.trim() : ''
    const mainAccountId = transaction.MainAccountID != null ? String(transaction.MainAccountID).trim() : ''

    // Data-importer: builds candidate list from all identity fields including bb-account- prefix (lines 2210-2217).
    const candidates = uniqueStrings([
      accountIban !== '' ? accountIban : undefined,
      encryptedIban !== '' ? encryptedIban : undefined,
      mainAccountId !== '' ? mainAccountId : undefined,
      mainAccountId !== '' ? `bb-account-${mainAccountId}` : undefined
    ])
    if (candidates.length === 0) {
      continue
    }

    const alreadyKnown = candidates.some(candidate => known.has(normalizeAccountKey(candidate)))
    if (alreadyKnown) {
      continue
    }

    // Data-importer: ID priority is accountIban > mainAccountId > encryptedIban (line 2233).
    let syntheticId: string
    if (accountIban !== '') {
      syntheticId = accountIban
    } else if (mainAccountId !== '') {
      syntheticId = mainAccountId
    } else {
      syntheticId = encryptedIban
    }

    // Data-importer: currency from normalizeOrEmpty which returns '' for unrecognized (line 2234).
    const rawCcy = transaction.Ccy != null ? transaction.Ccy.trim().toUpperCase() : ''
    const instrument = rawCcy !== '' && KNOWN_CURRENCIES_SET.has(rawCcy) ? rawCcy : ''
    const synthetic: ParsedAccountRow = {
      id: syntheticId,
      title: `BasisBank account ${syntheticId}`,
      iban: accountIban !== '' ? accountIban : undefined,
      bban: mainAccountId !== '' ? mainAccountId : undefined,
      instrument,
      balance: null,
      available: null,
      isCard: (transaction.CardPan ?? '').includes('****'),
      syncIds: candidates
    }

    additions.push(synthetic)
    for (const candidate of candidates) {
      known.set(normalizeAccountKey(candidate), true)
    }
  }

  return [...accounts, ...additions]
}
