import { CardAccountRow, CardTransactionRow, ParsedAccountRow } from '../models'
import {
  ensureAccountsForTransactions,
  mapCardAccount,
  mergeAccounts,
  normalizeAccountId,
  normalizeAccountKey,
  parseCurrencyFromText,
  parseRowAmounts
} from '../accounts'

describe('parseCurrencyFromText', () => {
  it.each<[string, string, string | undefined]>([
    ['detects lari symbol', 'Balance: 100 ₾', 'GEL'],
    ['detects euro symbol', 'Amount: 50 €', 'EUR'],
    ['detects alpha code USD', 'Balance: 100 USD', 'USD'],
    ['detects alpha code GEL', 'Account GEL balance', 'GEL'],
    ['rejects unknown 3-letter word', 'THE END', undefined],
    ['returns undefined for no currency', 'hello world', undefined],
    ['returns first known match among multiple currencies', '100 EUR 200 USD', 'EUR']
  ])('%s', (_, text, expected) => {
    expect(parseCurrencyFromText(text)).toBe(expected)
  })

  it('prefers symbol over alpha code when symbol appears in text', () => {
    // Symbol check runs before the regex scan, so "₾" wins over "USD"
    expect(parseCurrencyFromText('₾ 100 USD')).toBe('GEL')
  })
})

describe('parseRowAmounts', () => {
  it.each<[string, string[], number[]]>([
    ['single amount with thousands separator', ['Balance: 1,234.56'], [1234.56]],
    ['multiple amounts', ['100.00', '200.50'], [100, 200.5]],
    ['negative amount', ['-50.00'], [-50]],
    ['zero filtered out', ['0.00', '100'], [100]],
    ['no amounts', ['no numbers here'], []]
  ])('%s', (_, parts, expected) => {
    expect(parseRowAmounts(parts)).toEqual(expected)
  })
})

describe('mapCardAccount', () => {
  it('maps card with IBAN to ParsedAccountRow with id=iban and isCard=true', () => {
    const row: CardAccountRow = {
      AccountIban: 'GE29BB0000000012345678',
      AccountIbanEncrypted: 'ENC123',
      MainAccountID: '999',
      AccountName: 'My Card',
      MainCCy: 'USD',
      Amount: '1500.00'
    }

    const result = mapCardAccount(row)

    expect(result).not.toBeNull()
    expect(result!.id).toBe('GE29BB0000000012345678')
    expect(result!.isCard).toBe(true)
    expect(result!.title).toBe('My Card')
    expect(result!.balance).toBe(1500)
    expect(result!.instrument).toBe('USD')
    expect(result!.iban).toBe('GE29BB0000000012345678')
    expect(result!.bban).toBe('999')
    expect(result!.syncIds).toContain('GE29BB0000000012345678')
    expect(result!.syncIds).toContain('ENC123')
    expect(result!.syncIds).toContain('999')
  })

  it('uses encrypted IBAN as id when plain IBAN is absent', () => {
    const row: CardAccountRow = {
      AccountIbanEncrypted: 'ENC456',
      MainAccountID: '100',
      ProductName: 'Gold Card',
      MainCCy: 'GEL',
      Amount: '200'
    }

    const result = mapCardAccount(row)

    expect(result).not.toBeNull()
    expect(result!.id).toBe('ENC456')
    expect(result!.iban).toBeUndefined()
  })

  it('uses bb-card-{MainAccountID} as id when no IBAN fields exist', () => {
    const row: CardAccountRow = {
      MainAccountID: '42',
      AccountDescription: 'Savings',
      MainCCy: 'EUR',
      Amount: '0'
    }

    const result = mapCardAccount(row)

    expect(result).not.toBeNull()
    expect(result!.id).toBe('bb-card-42')
    expect(result!.iban).toBeUndefined()
  })

  it('returns null when no identifiers are present', () => {
    const row: CardAccountRow = {
      AccountName: 'Orphan Card',
      MainCCy: 'GEL'
    }

    expect(mapCardAccount(row)).toBeNull()
  })

  it('sets instrument to uppercase known currency code', () => {
    const row: CardAccountRow = {
      AccountIban: 'GE11BB0000000000000001',
      MainCCy: 'usd',
      Amount: '10'
    }

    const result = mapCardAccount(row)
    expect(result!.instrument).toBe('USD')
  })

  it('sets instrument to empty string for unknown currency', () => {
    const row: CardAccountRow = {
      AccountIban: 'GE11BB0000000000000002',
      MainCCy: 'XYZ',
      Amount: '10'
    }

    const result = mapCardAccount(row)
    expect(result!.instrument).toBe('')
  })

  it('falls back to CcyArray when MainCCy is absent', () => {
    const row: CardAccountRow = {
      AccountIban: 'GE11BB0000000000000003',
      CcyArray: ['GEL'],
      Amount: '10'
    }

    const result = mapCardAccount(row)
    expect(result!.instrument).toBe('GEL')
  })
})

describe('mergeAccounts', () => {
  function makeBalanceAccount (overrides: Partial<ParsedAccountRow> = {}): ParsedAccountRow {
    return {
      id: 'GE00BB0000000000000001',
      title: 'Balance Account',
      iban: 'GE00BB0000000000000001',
      bban: '101',
      instrument: 'GEL',
      balance: 500,
      available: 500,
      isCard: false,
      syncIds: ['GE00BB0000000000000001', '101'],
      ...overrides
    }
  }

  it('overrides balance account fields when card matches by syncId', () => {
    const balanceAccounts: ParsedAccountRow[] = [makeBalanceAccount()]
    const cardRows: CardAccountRow[] = [
      {
        AccountIban: 'GE00BB0000000000000001',
        MainAccountID: '101',
        AccountName: 'Visa Gold',
        MainCCy: 'GEL',
        Amount: '750'
      }
    ]

    const result = mergeAccounts(balanceAccounts, cardRows)

    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Visa Gold')
    expect(result[0].balance).toBe(750)
    expect(result[0].isCard).toBe(true)
  })

  it('merges syncIds from both sources', () => {
    const balanceAccounts: ParsedAccountRow[] = [
      makeBalanceAccount({ syncIds: ['GE00BB0000000000000001', 'bb-account-101'] })
    ]
    const cardRows: CardAccountRow[] = [
      {
        AccountIban: 'GE00BB0000000000000001',
        AccountIbanEncrypted: 'ENC789',
        MainAccountID: '101',
        AccountName: 'Card',
        MainCCy: 'GEL',
        Amount: '500'
      }
    ]

    const result = mergeAccounts(balanceAccounts, cardRows)

    expect(result[0].syncIds).toContain('GE00BB0000000000000001')
    expect(result[0].syncIds).toContain('bb-account-101')
    expect(result[0].syncIds).toContain('ENC789')
    expect(result[0].syncIds).toContain('101')
  })

  it('does not mutate the input arrays', () => {
    const balanceAccounts: ParsedAccountRow[] = [makeBalanceAccount()]
    const cardRows: CardAccountRow[] = [
      {
        AccountIban: 'GE00BB0000000000000001',
        MainAccountID: '101',
        AccountName: 'Card',
        MainCCy: 'GEL',
        Amount: '750'
      }
    ]
    const originalBalanceLength = balanceAccounts.length
    const originalCardLength = cardRows.length

    mergeAccounts(balanceAccounts, cardRows)

    expect(balanceAccounts).toHaveLength(originalBalanceLength)
    expect(cardRows).toHaveLength(originalCardLength)
    // Original balance account should still have its original title
    expect(balanceAccounts[0].title).toBe('Balance Account')
  })

  it('passes through balance accounts unchanged when no card matches', () => {
    const balanceAccounts: ParsedAccountRow[] = [makeBalanceAccount()]
    const cardRows: CardAccountRow[] = [
      {
        AccountIban: 'GE99BB0000000099999999',
        MainAccountID: '999',
        AccountName: 'Unrelated Card',
        MainCCy: 'USD',
        Amount: '100'
      }
    ]

    const result = mergeAccounts(balanceAccounts, cardRows)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(balanceAccounts[0])
    expect(result[1].id).toBe('GE99BB0000000099999999')
  })
})

describe('ensureAccountsForTransactions', () => {
  function makeExistingAccount (overrides: Partial<ParsedAccountRow> = {}): ParsedAccountRow {
    return {
      id: 'GE00BB0000000000000001',
      title: 'Existing',
      iban: 'GE00BB0000000000000001',
      instrument: 'GEL',
      balance: 100,
      available: 100,
      isCard: false,
      syncIds: ['GE00BB0000000000000001'],
      ...overrides
    }
  }

  it('creates a synthetic account for a transaction with an unknown account', () => {
    const accounts: ParsedAccountRow[] = [makeExistingAccount()]
    const transactions: CardTransactionRow[] = [
      {
        AccountIban: 'GE77BB0000000077777777',
        MainAccountID: '777',
        Ccy: 'USD'
      }
    ]

    const result = ensureAccountsForTransactions(accounts, transactions)

    expect(result).toHaveLength(2)
    const synthetic = result[1]
    expect(synthetic.id).toBe('GE77BB0000000077777777')
    expect(synthetic.instrument).toBe('USD')
    expect(synthetic.balance).toBeNull()
    expect(synthetic.iban).toBe('GE77BB0000000077777777')
    expect(synthetic.bban).toBe('777')
  })

  it('does not create a synthetic account when the transaction matches a known account', () => {
    const accounts: ParsedAccountRow[] = [makeExistingAccount()]
    const transactions: CardTransactionRow[] = [
      {
        AccountIban: 'GE00BB0000000000000001',
        MainAccountID: '1'
      }
    ]

    const result = ensureAccountsForTransactions(accounts, transactions)

    expect(result).toHaveLength(1)
  })

  it('returns a new array without mutating the original', () => {
    const accounts: ParsedAccountRow[] = [makeExistingAccount()]
    const originalLength = accounts.length

    const transactions: CardTransactionRow[] = [
      {
        AccountIban: 'GE88BB0000000088888888',
        MainAccountID: '888'
      }
    ]

    const result = ensureAccountsForTransactions(accounts, transactions)

    expect(accounts).toHaveLength(originalLength)
    expect(result).not.toBe(accounts)
    expect(result).toHaveLength(2)
  })

  it('uses iban as synthetic ID when available', () => {
    const transactions: CardTransactionRow[] = [
      {
        AccountIban: 'GE55BB0000000055555555',
        MainAccountID: '555',
        AccountIbanEncrypted: 'ENCABC'
      }
    ]

    const result = ensureAccountsForTransactions([], transactions)

    expect(result[0].id).toBe('GE55BB0000000055555555')
  })

  it('uses mainAccountId as synthetic ID when iban is absent', () => {
    const transactions: CardTransactionRow[] = [
      {
        MainAccountID: '333',
        AccountIbanEncrypted: 'ENC333'
      }
    ]

    const result = ensureAccountsForTransactions([], transactions)

    expect(result[0].id).toBe('333')
  })

  it('uses encryptedIban as synthetic ID when iban and mainAccountId are absent', () => {
    const transactions: CardTransactionRow[] = [
      {
        AccountIbanEncrypted: 'ENCONLY'
      }
    ]

    const result = ensureAccountsForTransactions([], transactions)

    expect(result[0].id).toBe('ENCONLY')
  })

  it('sets isCard=true when CardPan contains ****', () => {
    const transactions: CardTransactionRow[] = [
      {
        AccountIban: 'GE44BB0000000044444444',
        CardPan: '4444****1234'
      }
    ]

    const result = ensureAccountsForTransactions([], transactions)

    expect(result[0].isCard).toBe(true)
  })

  it('sets isCard=false when CardPan does not contain ****', () => {
    const transactions: CardTransactionRow[] = [
      {
        AccountIban: 'GE44BB0000000044444444',
        CardPan: '4444123456781234'
      }
    ]

    const result = ensureAccountsForTransactions([], transactions)

    expect(result[0].isCard).toBe(false)
  })
})

describe('normalizeAccountKey', () => {
  it.each<[string, string, string]>([
    ['uppercases and strips whitespace', ' ge12basis ', 'GE12BASIS'],
    ['handles tabs and newlines', '\tAB\n12 CD\r', 'AB12CD'],
    ['returns empty for empty input', '', ''],
    ['handles already normalized input', 'GE00BB', 'GE00BB']
  ])('%s', (_, input, expected) => {
    expect(normalizeAccountKey(input)).toBe(expected)
  })
})

describe('normalizeAccountId', () => {
  it('returns iban when present', () => {
    const account: ParsedAccountRow = {
      id: 'some-id',
      title: 'Test',
      iban: 'GE00BB1234567890123456',
      instrument: 'GEL',
      balance: 0,
      available: 0,
      isCard: false,
      syncIds: ['some-id']
    }

    expect(normalizeAccountId(account)).toBe('GE00BB1234567890123456')
  })

  it('returns id when iban is absent', () => {
    const account: ParsedAccountRow = {
      id: 'fallback-id',
      title: 'Test',
      instrument: 'GEL',
      balance: 0,
      available: 0,
      isCard: false,
      syncIds: ['fallback-id']
    }

    expect(normalizeAccountId(account)).toBe('fallback-id')
  })

  it('returns id when iban is empty string', () => {
    const account: ParsedAccountRow = {
      id: 'fallback-id',
      title: 'Test',
      iban: '',
      instrument: 'GEL',
      balance: 0,
      available: 0,
      isCard: false,
      syncIds: ['fallback-id']
    }

    expect(normalizeAccountId(account)).toBe('fallback-id')
  })
})
