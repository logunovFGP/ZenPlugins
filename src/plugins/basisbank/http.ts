import { stringify } from 'querystring'
import { fetch, FetchOptions, FetchResponse } from '../../common/network'
import { TemporaryError } from '../../errors'
import { RequestOptions } from './models'
import { isRecord } from './utils'

export type { FetchResponse } from '../../common/network'

// ─── Constants ───────────────────────────────────────────────────────────────

export const BASE_URL = 'https://www.bankonline.ge'
export const DEFAULT_PAGE_SIZE_GUESS = 20
export const MAX_TRANSACTION_PAGES = 120
// Data-importer: MAX_RETRY_ATTEMPTS = 4, BASE_RETRY_DELAY_MS = 450 (GetTransactionsRequest lines 30-31).
export const MAX_TRANSIENT_RETRY_ATTEMPTS = 4
export const BASE_RETRY_DELAY_MS = 450
// Data-importer retryable status codes (line 1560).
export const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 520, 522, 524])

// ─── Low-level helpers ───────────────────────────────────────────────────────

export function getStringProp (source: unknown, key: string): string | undefined {
  if (!isRecord(source)) {
    return undefined
  }
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

export function normalizeUrlPath (path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path
  }
  return `${BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`
}

export function getHeader (response: FetchResponse, name: string): string | undefined {
  const headers = response.headers
  if (headers == null) {
    return undefined
  }

  const normalizedName = name.toLowerCase()
  if (isRecord(headers)) {
    const direct = headers[name] ?? headers[normalizedName]
    if (typeof direct === 'string') {
      return direct
    }
  }

  const withGet = headers as { get?: (headerName: string) => string | null }
  if (typeof withGet.get === 'function') {
    const value = withGet.get(name) ?? withGet.get(normalizedName)
    if (value != null && value !== '') {
      return value
    }
  }

  return undefined
}

export function asStringBody (response: FetchResponse): string {
  if (typeof response.body === 'string') {
    return response.body
  }
  if (response.body == null) {
    return ''
  }
  return String(response.body)
}

export function parseJsonBody (response: FetchResponse, context: string): unknown {
  if (isRecord(response.body) || Array.isArray(response.body)) {
    return response.body
  }

  const bodyText = asStringBody(response).trim()
  if (bodyText === '') {
    return null
  }

  try {
    return JSON.parse(bodyText)
  } catch (error) {
    if (bodyText.startsWith('<')) {
      throw new TemporaryError(`${context}: expected JSON response, received HTML`)
    }
    return bodyText
  }
}

// Data-importer DATE_FORMAT = 'd/m/Y' (PHP) which zero-pads day and month.
// e.g. 2026-03-01 => "01/03/2026", NOT "1/3/2026".
export function formatCardDate (date: Date): string {
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${day}/${month}/${date.getFullYear()}`
}

export function getMaskedBodyKeys (baseKeys: string[], form: Record<string, string> | undefined): string[] {
  const masked = [...baseKeys]
  if (form != null) {
    for (const key of Object.keys(form)) {
      if (/password|ptxt|otpcodetxt|otp|session|cookie|login|utxt/i.test(key)) {
        masked.push(key)
      }
    }
  }
  return [...new Set(masked)]
}

export async function request (options: RequestOptions): Promise<FetchResponse> {
  const url = normalizeUrlPath(options.path)
  const headers: Record<string, string> = {
    Accept: options.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    ...options.headers
  }

  if (options.refererPath != null) {
    headers.Referer = normalizeUrlPath(options.refererPath)
  }

  const fetchOptions: FetchOptions = {
    method: options.method ?? 'GET',
    headers,
    redirect: options.redirect,
    sanitizeRequestLog: {
      headers: { Cookie: true },
      ...options.form != null
        ? { body: Object.fromEntries(getMaskedBodyKeys(options.sanitizeBodyKeys ?? [], options.form).map(key => [key, true])) }
        : {}
    },
    sanitizeResponseLog: {
      headers: {
        'set-cookie': true
      }
    }
  }

  if (options.form != null) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
    fetchOptions.body = options.form
    fetchOptions.stringify = (body: unknown): string => stringify(body as Record<string, string>)
  }

  return await fetch(url, fetchOptions)
}

// ─── Payload parsing ─────────────────────────────────────────────────────────

export function parsePossibleJsonContainer (value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }
  const text = value.trim()
  if (text === '' || !(text.startsWith('{') || text.startsWith('['))) {
    return value
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    return value
  }
}

export function extractArrayPayloadWithShape (payload: unknown): { rows: unknown[], recognized: boolean } {
  payload = parsePossibleJsonContainer(payload)
  if (Array.isArray(payload)) {
    return { rows: payload, recognized: true }
  }

  if (!isRecord(payload)) {
    return { rows: [], recognized: false }
  }

  for (const key of ['d', 'data', 'Data', 'result', 'Result', 'items', 'Items', 'List']) {
    if (!(key in payload)) {
      continue
    }
    const value = parsePossibleJsonContainer(payload[key])
    if (Array.isArray(value)) {
      return { rows: value, recognized: true }
    }
    if (isRecord(value)) {
      for (const nestedKey of ['items', 'Items', 'rows', 'Rows', 'transactions', 'Transactions']) {
        if (!(nestedKey in value)) {
          continue
        }
        const nested = parsePossibleJsonContainer(value[nestedKey])
        if (Array.isArray(nested)) {
          return { rows: nested, recognized: true }
        }
      }
    }
  }

  return { rows: [], recognized: false }
}

export function extractArrayPayload (payload: unknown): unknown[] {
  return extractArrayPayloadWithShape(payload).rows
}

export function isDeadSessionPayload (payload: unknown): boolean {
  if (typeof payload === 'string') {
    return /DeadSession/i.test(payload)
  }

  if (!isRecord(payload)) {
    return false
  }

  const status = getStringProp(payload, 'Status') ?? getStringProp(payload, 'status')
  if (status != null && /DeadSession/i.test(status)) {
    return true
  }

  const nested = payload.d
  return typeof nested === 'string' && /DeadSession/i.test(nested)
}

// ─── Session / retry helpers ─────────────────────────────────────────────────

export function containsLoginForm (html: string): boolean {
  return html.includes('id="UTXT"') && html.includes('id="PTXT"')
}

// Data-importer: isRetryableCardModuleFailure (lines 1557-1570).
// Transient HTTP errors that should be retried with exponential backoff.
export function isRetryableTransientError (error: unknown): boolean {
  if (error instanceof TemporaryError) {
    const message = error.message.toLowerCase()
    // Data-importer checks status codes 429, 500-504, 520, 522, 524 and keyword matches.
    for (const code of RETRYABLE_STATUS_CODES) {
      if (message.includes(String(code))) {
        return true
      }
    }
    return message.includes('timeout') ||
      message.includes('gateway') ||
      message.includes('rate limit') ||
      message.includes('temporarily unavailable')
  }
  return false
}

export function sleep (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
