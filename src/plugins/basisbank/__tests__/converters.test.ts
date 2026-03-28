import { convertAccount, convertAccounts, convertTransactions, splitAccountsByCurrency } from '../converters'
import { CardTransactionRow, ParsedAccountRow } from '../models'
import { AccountOrCard, AccountType } from '../../../types/zenmoney'

// Mock the ZenMoney global used by convertTransaction() internally.
beforeEach(() => {
  global.ZenMoney = {
    isAccountSkipped: jest.fn().mockReturnValue(false)
  } as any
})

afterEach(() => {
  delete (global as any).ZenMoney
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAccountRow (overrides: Partial<ParsedAccountRow> = {}): ParsedAccountRow {
  return {
    id: 'GE00BB0000000000000001',
    title: 'My Account',
    instrument: 'GEL',
    balance: 1000,
    available: 1000,
    isCard: false,
    iban: 'GE00BB0000000000000001',
    syncIds: ['GE00BB0000000000000001'],
    ...overrides
  }
}

function makeWebRow (overrides: Partial<CardTransactionRow> = {}): CardTransactionRow {
  return {
    TransactionID: 'TXN001',
    AccountIban: 'GE00BB0000000000000001',
    Description: 'Payment for services',
    Amount: '100.00',
    Ccy: 'GEL',
    DocDate: '15.01.2025',
    CreditDebitIndicator: 'DBIT',
    ...overrides
  }
}

function makePsd2Row (overrides: Partial<CardTransactionRow> = {}): CardTransactionRow {
  return {
    transactionId: 'PSD2-001',
    accountId: 'GE00BB0000000000000001',
    transactionAmount: { amount: '50.00', currency: 'GEL' },
    bookingDate: '2025-01-15',
    remittanceInformationUnstructured: 'PSD2 payment',
    creditorName: 'Some Merchant',
    ...overrides
  }
}

function makeConvertedAccount (overrides: Partial<AccountOrCard> = {}): AccountOrCard {
  return {
    id: 'GE00BB0000000000000001',
    type: AccountType.checking,
    title: 'My Account',
    instrument: 'GEL',
    syncIds: ['GE00BB0000000000000001'],
    balance: 1000,
    available: 1000,
    ...overrides
  }
}

// ─── convertAccount ──────────────────────────────────────────────────────────

describe('convertAccount', () => {
  it('produces AccountOrCard with correct id, type, title, instrument, syncIds', () => {
    const row = makeAccountRow()
    const result = convertAccount(row)

    expect(result.id).toBe('GE00BB0000000000000001')
    expect(result.type).toBe(AccountType.checking)
    expect(result.title).toBe('My Account')
    expect(result.instrument).toBe('GEL')
    expect(result.syncIds).toEqual(['GE00BB0000000000000001'])
    expect(result.balance).toBe(1000)
    expect(result.available).toBe(1000)
  })

  it('sets type to ccard when isCard is true', () => {
    const row = makeAccountRow({ isCard: true })
    const result = convertAccount(row)

    expect(result.type).toBe(AccountType.ccard)
  })

  it('sets type to checking when isCard is false', () => {
    const row = makeAccountRow({ isCard: false })
    const result = convertAccount(row)

    expect(result.type).toBe(AccountType.checking)
  })

  it('defaults instrument to GEL when missing', () => {
    const row = makeAccountRow({ instrument: '' })
    const result = convertAccount(row)

    expect(result.instrument).toBe('GEL')
  })

  it('defaults instrument to GEL when whitespace-only', () => {
    const row = makeAccountRow({ instrument: '   ' })
    const result = convertAccount(row)

    expect(result.instrument).toBe('GEL')
  })

  it('defaults title to id when title is empty', () => {
    const row = makeAccountRow({ title: '' })
    const result = convertAccount(row)

    expect(result.title).toBe(row.id)
  })

  it('defaults title to id when title is whitespace-only', () => {
    const row = makeAccountRow({ title: '   ' })
    const result = convertAccount(row)

    expect(result.title).toBe(row.id)
  })

  it('deduplicates syncIds from id, iban, and syncIds array', () => {
    const row = makeAccountRow({
      id: 'ACC1',
      iban: 'ACC1',
      syncIds: ['ACC1', 'EXTRA']
    })
    const result = convertAccount(row)

    expect(result.syncIds).toEqual(['ACC1', 'EXTRA'])
  })
})

// ─── convertAccounts ─────────────────────────────────────────────────────────

describe('convertAccounts', () => {
  it('converts multiple accounts', () => {
    const rows = [
      makeAccountRow({ id: 'ACC1', title: 'Account 1', iban: 'ACC1', syncIds: ['ACC1'] }),
      makeAccountRow({ id: 'ACC2', title: 'Account 2', iban: 'ACC2', syncIds: ['ACC2'] })
    ]
    const result = convertAccounts(rows)

    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('ACC1')
    expect(result[1].id).toBe('ACC2')
  })

  it('deduplicates by id, last wins', () => {
    const rows = [
      makeAccountRow({ id: 'ACC1', title: 'First', iban: 'ACC1', syncIds: ['ACC1'] }),
      makeAccountRow({ id: 'ACC1', title: 'Second', iban: 'ACC1', syncIds: ['ACC1'] })
    ]
    const result = convertAccounts(rows)

    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Second')
  })

  it('returns empty array for empty input', () => {
    expect(convertAccounts([])).toEqual([])
  })
})

// ─── convertTransactions — dedup behavior ────────────────────────────────────

describe('convertTransactions — dedup', () => {
  const account = makeConvertedAccount()

  it('filters duplicate movement ID on the same account', () => {
    const row1 = makeWebRow({ TransactionID: 'DUP1' })
    const row2 = makeWebRow({ TransactionID: 'DUP1' })

    const result = convertTransactions([row1, row2], [], [account])

    expect(result).toHaveLength(1)
  })

  it('keeps both when same content but different movement IDs', () => {
    const row1 = makeWebRow({ TransactionID: 'ID_A', Description: 'Same desc', Amount: '50', DocDate: '15.01.2025' })
    const row2 = makeWebRow({ TransactionID: 'ID_B', Description: 'Same desc', Amount: '50', DocDate: '15.01.2025' })

    const result = convertTransactions([row1, row2], [], [account])

    expect(result).toHaveLength(2)
  })

  it('filters second row when same content and one has no movement ID', () => {
    const row1 = makeWebRow({
      TransactionID: undefined,
      TransferID: undefined,
      TransactionReference: undefined,
      Description: 'Same desc',
      Amount: '50',
      DocDate: '15.01.2025'
    })
    const row2 = makeWebRow({
      TransactionID: undefined,
      TransferID: undefined,
      TransactionReference: undefined,
      Description: 'Same desc',
      Amount: '50',
      DocDate: '15.01.2025'
    })

    const result = convertTransactions([row1, row2], [], [account])

    expect(result).toHaveLength(1)
  })

  it('filters transactions before fromDate', () => {
    const row = makeWebRow({ DocDate: '01.01.2025' })
    const fromDate = new Date(2025, 0, 10)

    const result = convertTransactions([row], [], [account], fromDate)

    expect(result).toHaveLength(0)
  })

  it('filters transactions after toDate', () => {
    const row = makeWebRow({ DocDate: '20.01.2025' })
    const toDate = new Date(2025, 0, 10)

    const result = convertTransactions([row], [], [account], undefined, toDate)

    expect(result).toHaveLength(0)
  })

  it('keeps transactions within date range', () => {
    const row = makeWebRow({ DocDate: '15.01.2025' })
    const fromDate = new Date(2025, 0, 1)
    const toDate = new Date(2025, 0, 31)

    const result = convertTransactions([row], [], [account], fromDate, toDate)

    expect(result).toHaveLength(1)
  })
})

// ─── convertTransactions — amount/currency ───────────────────────────────────

describe('convertTransactions — amount/currency', () => {
  const account = makeConvertedAccount({ instrument: 'GEL' })

  it('DBIT indicator produces negative amount', () => {
    const row = makeWebRow({ CreditDebitIndicator: 'DBIT', Amount: '100' })

    const result = convertTransactions([row], [], [account])

    expect(result).toHaveLength(1)
    expect(result[0].movements[0].sum).toBe(-100)
  })

  it('CRDT indicator produces positive amount', () => {
    const row = makeWebRow({ CreditDebitIndicator: 'CRDT', Amount: '100' })

    const result = convertTransactions([row], [], [account])

    expect(result).toHaveLength(1)
    expect(result[0].movements[0].sum).toBe(100)
  })

  it('creates invoice when transaction currency differs from account', () => {
    const row = makeWebRow({ Ccy: 'USD', Amount: '50', CreditDebitIndicator: 'DBIT' })

    const result = convertTransactions([row], [], [account])

    expect(result).toHaveLength(1)
    expect(result[0].movements[0].invoice).toEqual({ sum: -50, instrument: 'USD' })
  })

  it('sets invoice to null when transaction currency matches account', () => {
    const row = makeWebRow({ Ccy: 'GEL', Amount: '50', CreditDebitIndicator: 'DBIT' })

    const result = convertTransactions([row], [], [account])

    expect(result).toHaveLength(1)
    expect(result[0].movements[0].invoice).toBeNull()
  })

  it('skips transactions with zero amount', () => {
    const row = makeWebRow({ Amount: '0' })

    const result = convertTransactions([row], [], [account])

    expect(result).toHaveLength(0)
  })

  it('skips transactions with null amount', () => {
    const row = makeWebRow({ Amount: undefined })

    const result = convertTransactions([row], [], [account])

    expect(result).toHaveLength(0)
  })
})

// ─── convertTransactions — merchant ──────────────────────────────────────────

describe('convertTransactions — merchant', () => {
  const account = makeConvertedAccount()

  it('sets merchant to null when merchant title equals description (web row)', () => {
    const row = makeWebRow({ Description: 'Coffee Shop', CreditDebitIndicator: 'DBIT' })
    // For web rows, Description is used as both description and merchant title,
    // so merchant should be null to avoid duplication.

    const result = convertTransactions([row], [], [account])

    expect(result).toHaveLength(1)
    expect(result[0].merchant).toBeNull()
  })

  it('sets merchant when creditorName differs from description (PSD2 row)', () => {
    const row = makePsd2Row({
      remittanceInformationUnstructured: 'Payment for order #123',
      creditorName: 'ACME Corp'
    })

    const result = convertTransactions([row], [], [account])

    expect(result).toHaveLength(1)
    expect(result[0].merchant).toEqual({
      fullTitle: 'ACME Corp',
      mcc: null,
      location: null
    })
  })

  it('sets merchant to null when creditorName matches description (PSD2 row)', () => {
    const row = makePsd2Row({
      remittanceInformationUnstructured: 'ACME Corp',
      creditorName: 'ACME Corp'
    })

    const result = convertTransactions([row], [], [account])

    expect(result).toHaveLength(1)
    expect(result[0].merchant).toBeNull()
  })
})

// ─── convertTransactions — hold flag ─────────────────────────────────────────

describe('convertTransactions — hold flag', () => {
  const account = makeConvertedAccount()

  it('booked transactions have hold=false', () => {
    const row = makeWebRow()
    const result = convertTransactions([row], [], [account])

    expect(result).toHaveLength(1)
    expect(result[0].hold).toBe(false)
  })

  it('pending transactions have hold=true', () => {
    const row = makeWebRow()
    const result = convertTransactions([], [row], [account])

    expect(result).toHaveLength(1)
    expect(result[0].hold).toBe(true)
  })

  it('processes both booked and pending in same call', () => {
    const booked = makeWebRow({ TransactionID: 'BOOKED1' })
    const pending = makeWebRow({ TransactionID: 'PEND1' })

    const result = convertTransactions([booked], [pending], [account])

    expect(result).toHaveLength(2)
    const bookedTxn = result.find(t => !t.hold)
    const pendingTxn = result.find(t => t.hold)
    expect(bookedTxn).toBeDefined()
    expect(pendingTxn).toBeDefined()
  })
})

// ─── convertTransactions — skipped accounts ──────────────────────────────────

describe('convertTransactions — skipped accounts', () => {
  it('filters transactions when account is skipped', () => {
    ;(ZenMoney.isAccountSkipped as jest.Mock).mockReturnValue(true)
    const account = makeConvertedAccount()
    const row = makeWebRow()

    const result = convertTransactions([row], [], [account])

    expect(result).toHaveLength(0)
  })
})

// ─── splitAccountsByCurrency ─────────────────────────────────────────────────

describe('splitAccountsByCurrency', () => {
  it('passes through single-currency account unchanged', () => {
    const account = makeAccountRow({ id: 'ACC1', instrument: 'GEL', iban: 'ACC1', syncIds: ['ACC1'] })
    const transactions = [
      makeWebRow({ AccountIban: 'ACC1', Ccy: 'GEL' })
    ]

    const result = splitAccountsByCurrency([account], transactions)

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('ACC1')
    expect(result[0].instrument).toBe('GEL')
  })

  it('splits multi-currency account into scoped accounts', () => {
    const account = makeAccountRow({ id: 'ACC1', title: 'Main', instrument: 'GEL', iban: 'ACC1', syncIds: ['ACC1'] })
    const transactions = [
      makeWebRow({ AccountIban: 'ACC1', Ccy: 'EUR', TransactionID: 'T1' }),
      makeWebRow({ AccountIban: 'ACC1', Ccy: 'USD', TransactionID: 'T2' })
    ]

    const result = splitAccountsByCurrency([account], transactions)

    expect(result.length).toBeGreaterThanOrEqual(2)

    const eurAccount = result.find(a => a.id === 'ACC1#EUR')
    const usdAccount = result.find(a => a.id === 'ACC1#USD')

    expect(eurAccount).toBeDefined()
    expect(usdAccount).toBeDefined()
  })

  it('scoped account titles include currency', () => {
    const account = makeAccountRow({ id: 'ACC1', title: 'Account', instrument: 'GEL', iban: 'ACC1', syncIds: ['ACC1'] })
    const transactions = [
      makeWebRow({ AccountIban: 'ACC1', Ccy: 'EUR', TransactionID: 'T1' }),
      makeWebRow({ AccountIban: 'ACC1', Ccy: 'USD', TransactionID: 'T2' })
    ]

    const result = splitAccountsByCurrency([account], transactions)

    const eurAccount = result.find(a => a.id === 'ACC1#EUR')
    const usdAccount = result.find(a => a.id === 'ACC1#USD')

    expect(eurAccount?.title).toBe('Account (EUR)')
    expect(usdAccount?.title).toBe('Account (USD)')
  })

  it('scoped accounts have correct instrument', () => {
    const account = makeAccountRow({ id: 'ACC1', title: 'Account', instrument: 'GEL', iban: 'ACC1', syncIds: ['ACC1'] })
    const transactions = [
      makeWebRow({ AccountIban: 'ACC1', Ccy: 'EUR', TransactionID: 'T1' }),
      makeWebRow({ AccountIban: 'ACC1', Ccy: 'USD', TransactionID: 'T2' })
    ]

    const result = splitAccountsByCurrency([account], transactions)

    const eurAccount = result.find(a => a.id === 'ACC1#EUR')
    const usdAccount = result.find(a => a.id === 'ACC1#USD')

    expect(eurAccount?.instrument).toBe('EUR')
    expect(usdAccount?.instrument).toBe('USD')
  })

  it('scoped accounts include original IBAN in syncIds', () => {
    const account = makeAccountRow({ id: 'ACC1', title: 'Account', instrument: 'GEL', iban: 'IBAN123', syncIds: ['ACC1'] })
    const transactions = [
      makeWebRow({ AccountIban: 'ACC1', Ccy: 'EUR', TransactionID: 'T1' }),
      makeWebRow({ AccountIban: 'ACC1', Ccy: 'USD', TransactionID: 'T2' })
    ]

    const result = splitAccountsByCurrency([account], transactions)

    const eurAccount = result.find(a => a.id === 'ACC1#EUR')
    expect(eurAccount?.syncIds).toContain('ACC1')
    expect(eurAccount?.syncIds).toContain('IBAN123')
    expect(eurAccount?.syncIds).toContain('ACC1#EUR')
  })

  it('does not split when all transactions use the same currency', () => {
    const account = makeAccountRow({ id: 'ACC1', instrument: 'GEL', iban: 'ACC1', syncIds: ['ACC1'] })
    const transactions = [
      makeWebRow({ AccountIban: 'ACC1', Ccy: 'GEL', TransactionID: 'T1' }),
      makeWebRow({ AccountIban: 'ACC1', Ccy: 'GEL', TransactionID: 'T2' })
    ]

    const result = splitAccountsByCurrency([account], transactions)

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('ACC1')
  })

  it('does not split when there are no transactions', () => {
    const account = makeAccountRow({ id: 'ACC1', instrument: 'GEL', iban: 'ACC1', syncIds: ['ACC1'] })

    const result = splitAccountsByCurrency([account], [])

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('ACC1')
  })

  it('includes the account base currency in scoped accounts', () => {
    const account = makeAccountRow({ id: 'ACC1', title: 'Main', instrument: 'GEL', iban: 'ACC1', syncIds: ['ACC1'] })
    const transactions = [
      makeWebRow({ AccountIban: 'ACC1', Ccy: 'USD', TransactionID: 'T1' })
    ]
    // Account instrument is GEL + one USD transaction => 2 currencies => split.

    const result = splitAccountsByCurrency([account], transactions)

    expect(result.length).toBeGreaterThanOrEqual(2)
    const gelAccount = result.find(a => a.id === 'ACC1#GEL')
    const usdAccount = result.find(a => a.id === 'ACC1#USD')
    expect(gelAccount).toBeDefined()
    expect(usdAccount).toBeDefined()
  })
})

// ─── convertTransactions — PSD2 row format ───────────────────────────────────

describe('convertTransactions — PSD2 rows', () => {
  const account = makeConvertedAccount()

  it('converts PSD2 row with nested transactionAmount', () => {
    const row = makePsd2Row({
      transactionAmount: { amount: '75.50', currency: 'GEL' }
    })

    const result = convertTransactions([row], [], [account])

    expect(result).toHaveLength(1)
    expect(result[0].movements[0].sum).toBe(75.5)
  })

  it('uses remittanceInformationUnstructuredArray for description', () => {
    const row = makePsd2Row({
      remittanceInformationUnstructuredArray: ['Payment', 'for services'],
      remittanceInformationUnstructured: 'Should not be used'
    })

    const result = convertTransactions([row], [], [account])

    expect(result).toHaveLength(1)
    expect(result[0].comment).toBe('Payment for services')
  })

  it('falls back to remittanceInformationUnstructured for description', () => {
    const row = makePsd2Row({
      remittanceInformationUnstructuredArray: undefined,
      remittanceInformationUnstructured: 'Fallback description'
    })

    const result = convertTransactions([row], [], [account])

    expect(result).toHaveLength(1)
    expect(result[0].comment).toBe('Fallback description')
  })

  it('uses debtorName as merchant when creditorName is absent', () => {
    const row = makePsd2Row({
      creditorName: undefined,
      debtorName: 'John Doe',
      remittanceInformationUnstructured: 'Income transfer'
    })

    const result = convertTransactions([row], [], [account])

    expect(result).toHaveLength(1)
    expect(result[0].merchant).toEqual({
      fullTitle: 'John Doe',
      mcc: null,
      location: null
    })
  })
})

// ─── convertTransactions — sorting ───────────────────────────────────────────

describe('convertTransactions — sorting', () => {
  const account = makeConvertedAccount()

  it('returns transactions sorted by date ascending', () => {
    const row1 = makeWebRow({ TransactionID: 'T1', DocDate: '20.01.2025', CreditDebitIndicator: 'DBIT' })
    const row2 = makeWebRow({ TransactionID: 'T2', DocDate: '10.01.2025', CreditDebitIndicator: 'DBIT' })
    const row3 = makeWebRow({ TransactionID: 'T3', DocDate: '15.01.2025', CreditDebitIndicator: 'DBIT' })

    const result = convertTransactions([row1, row2, row3], [], [account])

    expect(result).toHaveLength(3)
    expect(result[0].date.getDate()).toBe(10)
    expect(result[1].date.getDate()).toBe(15)
    expect(result[2].date.getDate()).toBe(20)
  })
})
