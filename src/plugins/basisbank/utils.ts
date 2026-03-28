// Pure utility functions shared between converters.ts and fetchApi.ts.
// No side effects — every export is a pure function or immutable constant.

export function isNonEmptyString (value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isAmountObject (val: unknown): val is { amount?: string | number, currency?: string } {
  return val != null && typeof val === 'object' && !Array.isArray(val)
}

export function trimOrUndefined (value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function normalizeWhitespace (value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function uniqueStrings (values: Array<string | undefined>): string[] {
  const out: string[] = []
  for (const value of values) {
    if (value == null) {
      continue
    }
    const normalized = value.trim()
    if (normalized === '' || out.includes(normalized)) {
      continue
    }
    out.push(normalized)
  }
  return out
}

/**
 * Parse a numeric value from various formats.
 * Matches data-importer's parseAmountValue() logic:
 * - is_numeric shortcut (accepts scientific notation, signed numbers)
 * - Strip \u00A0 and spaces, then strip all non [0-9,.\-]
 * - Bracket-wrapped values treated as negative: (123) → -123
 * - European format detection via lastIndexOf of comma vs dot
 * - Double-dot cleanup: '..' → '.'
 * - Returns 0 for non-parseable (matching data-importer's 0.0 return)
 */
export function parseNumber (value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value === 'string') {
    // Match data-importer's is_numeric() shortcut — accepts scientific notation, hex, signed.
    const trimmed = value.trim()
    if (trimmed !== '' && !isNaN(Number(trimmed))) {
      const quick = Number(trimmed)
      if (Number.isFinite(quick)) {
        return quick
      }
    }

    // Strip \u00A0 and spaces (matching data-importer line 2130).
    let normalized = value.replace(/\u00a0/g, '').replace(/ /g, '')
    normalized = normalized.trim()

    // Handle bracket-wrapped negatives BEFORE stripping non-numeric chars
    // (matching data-importer lines 2131-2133).
    const negative = normalized.startsWith('(') && normalized.endsWith(')')
    if (negative) {
      normalized = '-' + normalized.slice(1, -1).trim()
    }

    // Strip all non [0-9,.\-] (matching data-importer line 2135).
    normalized = normalized.replace(/[^0-9,.\-]/g, '')

    if (normalized === '' || normalized === '-' || normalized === '.' || normalized === ',') {
      return null
    }

    // European/US format detection using lastIndexOf (matching data-importer lines 2144-2153).
    const comma = normalized.lastIndexOf(',')
    const dot = normalized.lastIndexOf('.')
    if (comma !== -1 && dot !== -1 && comma > dot) {
      // European: 1.234,56 → remove all dots, replace ALL commas with dot
      normalized = normalized.replace(/\./g, '').replace(/,/g, '.')
    } else if (comma !== -1 && dot === -1) {
      // Comma only (no dot): replace ALL commas with dot
      // (matching data-importer: str_replace(',', '.', $normalized) which replaces ALL)
      normalized = normalized.replace(/,/g, '.')
    } else {
      // Dot only or dot after comma (US): remove all commas
      normalized = normalized.replace(/,/g, '')
    }

    // Double-dot cleanup (matching data-importer line 2154).
    normalized = normalized.replace(/\.\./g, '.')

    const parsed = Number(normalized)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

// Numeric currency code → alpha mapping (matching data-importer's CurrencyCode::NUMERIC_TO_ALPHA).
export const NUMERIC_TO_ALPHA: Record<string, string> = {
  '840': 'USD',
  '978': 'EUR',
  '826': 'GBP',
  '643': 'RUB',
  '981': 'GEL',
  '756': 'CHF'
}

// Currency symbol → code mapping (matching data-importer's normalizeStatementCurrencyToken).
// Data-importer only maps ₾→GEL, €→EUR, $→USD. We add £→GBP, ₽→RUB, ₺→TRY for extra coverage.
export const CURRENCY_SYMBOLS: Record<string, string> = {
  '₾': 'GEL',
  '€': 'EUR',
  $: 'USD',
  '£': 'GBP',
  '₽': 'RUB',
  '₺': 'TRY'
}

// Full currency list matching data-importer's extractCurrency() regex — 49 codes.
export const KNOWN_CURRENCIES_SET = new Set([
  'AED', 'ARS', 'AUD', 'AZN', 'BGN', 'BRL', 'BSD', 'CAD', 'CHF', 'CLP',
  'CNY', 'COP', 'CRC', 'CZK', 'DKK', 'DOP', 'DZD', 'EGP', 'EUR', 'GBP',
  'GEL', 'HKD', 'HRK', 'HUF', 'IDR', 'ILS', 'INR', 'JPY', 'KGS', 'KZT',
  'MDL', 'MXN', 'NOK', 'PEN', 'PHP', 'PKR', 'PLN', 'RON', 'RSD', 'RUB',
  'SEK', 'SGD', 'THB', 'TRY', 'UAH', 'USD', 'UZS', 'VND', 'ZAR'
])

/**
 * Normalize a currency token to a 3-letter code.
 * Matches data-importer's CurrencyCode::normalizeOrEmpty():
 * - Any 3-letter alphabetic string is accepted (NOT a whitelist)
 * - Numeric codes are mapped via NUMERIC_TO_ALPHA
 * - Symbols are mapped via CURRENCY_SYMBOLS
 * - Returns undefined for invalid/empty values
 */
export function normalizeCurrencyToken (raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return undefined
  }
  // Check symbol first.
  const fromSymbol = CURRENCY_SYMBOLS[trimmed]
  if (fromSymbol != null) {
    return fromSymbol
  }
  const upper = trimmed.toUpperCase()
  // Match data-importer's CurrencyCode::normalizeOrEmpty:
  // Accept ANY 3-letter alphabetic string (ctype_alpha + strlen === 3).
  if (upper.length === 3 && /^[A-Z]{3}$/.test(upper)) {
    return upper
  }
  // Numeric code lookup (matching data-importer's NUMERIC_TO_ALPHA).
  const fromNumeric = NUMERIC_TO_ALPHA[upper]
  if (fromNumeric != null) {
    return fromNumeric
  }
  return undefined
}
