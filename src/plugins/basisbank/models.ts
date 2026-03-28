export interface Preferences {
  login: string
  password: string
  requestSmsCode?: boolean
  trustDevice?: boolean
  startDate: string
}

export interface Auth {
  login?: string
  lastSuccessfulLoginAt?: number
  deviceId?: string
  sessionExpiresAt?: number
  trustedDeviceExpiresAt?: number
}

export interface Session {
  auth: Auth
  deviceId: string
  login: string
  password: string
  requestSmsCode: boolean
  trustDevice: boolean
}

export interface CardAccountRow {
  AccountIbanEncrypted?: string
  AccountIban?: string
  IsOwnAccount?: boolean
  IsTrustedAccount?: boolean
  AccountName?: string
  AccountDescription?: string
  ProductName?: string
  CcyArray?: string[]
  CardImages?: string[]
  Amount?: string | number
  MainCCy?: string
  MainAccountID?: string | number
}

export interface ParsedAccountRow {
  id: string
  title: string
  name?: string
  iban?: string
  bban?: string
  instrument: string
  balance: number | null
  available: number | null
  isCard: boolean
  status?: string
  institution_name?: string
  institution_logo?: string
  provider?: string
  syncIds: string[]
  extra?: Record<string, string | number | null>
}

export interface CardTransactionRow {
  TransferID?: string | number
  TransactionID?: string | number
  TransactionReference?: string
  HasSimilar?: boolean
  TransferType?: string | number
  AccountIban?: string
  AccountIbanEncrypted?: string
  MainAccountID?: string | number
  CardPan?: string
  Description?: string
  Amount?: string | number
  Ccy?: string
  DocDate?: string
  DateTime?: string
  Date?: string
  Status?: string | number
  // Credit/debit indicator — determines amount sign.
  // BasisBank sends under varying field names depending on response source.
  CreditDebitIndicator?: string
  creditDebitIndicator?: string
  debitCreditIndicator?: string
  // PSD2-style structured description fields
  remittanceInformationUnstructuredArray?: string[]
  remittanceInformationUnstructured?: string
  additionalInformation?: string
  // PSD2-style lowercase description fallback (used when PSD2 fields are absent)
  description?: string
  // PSD2-style counterparty fields
  creditorName?: string
  debtorName?: string
  counterpartyName?: string
  // Nested amount objects (PSD2 API format)
  transactionAmount?: { amount?: string | number, currency?: string }
  amount?: { amount?: string | number, currency?: string } | string | number
  // PSD2-style ID fields
  transactionId?: string
  entryReference?: string
  internalTransactionId?: string
  // PSD2 date alternatives
  bookingDateTime?: string
  bookingDate?: string
  valueDate?: string
  transactionDate?: string
  date?: string
  // PSD2 currency (top-level)
  currency?: string
  // Account identity fields used for matching transactions to configured accounts
  accountId?: string
  sourceAccountId?: string
}

/**
 * PSD2 API account row — returned by the BasisBank PSD2 /accounts endpoint.
 * Distinct from CardAccountRow which comes from the web scraping CardModule.
 */
export interface Psd2AccountRow {
  resourceId?: string
  accountId?: string
  id?: string
  iban?: string
  accountNumber?: string
  name?: string
  product?: string
  maskedPan?: string
  currency?: string
  currencyCode?: string
  status?: string
  balances?: Array<{
    balanceAmount?: { amount?: string | number, currency?: string }
    balanceType?: string
  }>
}

// ─── Types shared across fetchApi modules ──────────────────────────────────────

export type AuthFailureKind =
  | 'balance-login-form'
  | 'cardmodule-status'
  | 'cardmodule-login-form'
  | 'dead-session'

export interface CookieShape {
  name?: unknown
  expires?: unknown
  expiry?: unknown
  expirationDate?: unknown
}

export interface RequestOptions {
  method?: 'GET' | 'POST'
  path: string
  form?: Record<string, string>
  headers?: Record<string, string>
  refererPath?: string
  accept?: string
  redirect?: 'follow' | 'manual'
  sanitizeBodyKeys?: string[]
}

export interface UserTransactionsResponse {
  booked: CardTransactionRow[]
  pending: CardTransactionRow[]
  accounts: ParsedAccountRow[]
}
