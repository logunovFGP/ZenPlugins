import {
  isAmountObject,
  isNonEmptyString,
  isRecord,
  normalizeCurrencyToken,
  normalizeWhitespace,
  parseNumber,
  trimOrUndefined,
  uniqueStrings
} from '../utils'

describe('parseNumber', () => {
  it.each([
    ['123', 123],
    ['-45.6', -45.6],
    ['0', 0],
    ['0.0', 0],
    ['-0', -0]
  ])('parses simple numeric string %s', (input, expected) => {
    expect(parseNumber(input)).toBe(expected)
  })

  it.each([
    ['1.234,56', 1234.56],
    ['10.000,99', 10000.99],
    ['1.000.000,50', 1000000.5]
  ])('parses European format %s', (input, expected) => {
    expect(parseNumber(input)).toBe(expected)
  })

  it.each([
    ['1,234.56', 1234.56],
    ['10,000.99', 10000.99],
    ['1,000,000.50', 1000000.5]
  ])('parses US format %s', (input, expected) => {
    expect(parseNumber(input)).toBe(expected)
  })

  it('treats comma-only as decimal separator', () => {
    expect(parseNumber('1,234')).toBe(1.234)
  })

  it('handles bracket-wrapped negative', () => {
    expect(parseNumber('(100)')).toBe(-100)
  })

  it('handles bracket-wrapped negative with decimals', () => {
    expect(parseNumber('(1,234.56)')).toBe(-1234.56)
  })

  it('strips non-breaking spaces (\\u00a0)', () => {
    expect(parseNumber('1\u00a0234')).toBe(1234)
  })

  it('strips regular spaces', () => {
    expect(parseNumber('1 234 567')).toBe(1234567)
  })

  it('parses scientific notation', () => {
    expect(parseNumber('1.5e3')).toBe(1500)
  })

  it('cleans up double dots', () => {
    expect(parseNumber('1..5')).toBe(1.5)
  })

  it.each([
    ['', null],
    ['   ', null],
    ['abc', null],
    ['---', null],
    ['...', null],
    [',', null]
  ])('returns null for non-parseable string %j', (input, expected) => {
    expect(parseNumber(input)).toBe(expected)
  })

  it('passes through finite number input', () => {
    expect(parseNumber(42)).toBe(42)
    expect(parseNumber(-3.14)).toBe(-3.14)
    expect(parseNumber(0)).toBe(0)
  })

  it('returns null for NaN', () => {
    expect(parseNumber(NaN)).toBe(null)
  })

  it('returns null for Infinity', () => {
    expect(parseNumber(Infinity)).toBe(null)
    expect(parseNumber(-Infinity)).toBe(null)
  })

  it.each([
    [null, null],
    [undefined, null],
    [true, null],
    [{}, null],
    [[], null]
  ])('returns null for non-string/non-number input %j', (input, expected) => {
    expect(parseNumber(input)).toBe(expected)
  })
})

describe('normalizeCurrencyToken', () => {
  it.each([
    ['\u20BE', 'GEL'],
    ['\u20AC', 'EUR'],
    ['$', 'USD'],
    ['\u00A3', 'GBP'],
    ['\u20BD', 'RUB'],
    ['\u20BA', 'TRY']
  ])('maps symbol %s to code %s', (input, expected) => {
    expect(normalizeCurrencyToken(input)).toBe(expected)
  })

  it.each([
    ['usd', 'USD'],
    ['gel', 'GEL'],
    ['eur', 'EUR']
  ])('uppercases alphabetic code %s', (input, expected) => {
    expect(normalizeCurrencyToken(input)).toBe(expected)
  })

  it.each([
    ['GEL', 'GEL'],
    ['USD', 'USD'],
    ['EUR', 'EUR']
  ])('passes through already-uppercase code %s', (input, expected) => {
    expect(normalizeCurrencyToken(input)).toBe(expected)
  })

  it.each([
    ['978', 'EUR'],
    ['840', 'USD'],
    ['826', 'GBP'],
    ['643', 'RUB'],
    ['981', 'GEL'],
    ['756', 'CHF']
  ])('maps numeric code %s to %s', (input, expected) => {
    expect(normalizeCurrencyToken(input)).toBe(expected)
  })

  it('returns undefined for empty string', () => {
    expect(normalizeCurrencyToken('')).toBeUndefined()
  })

  it('returns undefined for whitespace-only string', () => {
    expect(normalizeCurrencyToken('   ')).toBeUndefined()
  })

  it('returns undefined for too-long string', () => {
    expect(normalizeCurrencyToken('ABCD')).toBeUndefined()
  })

  it('returns undefined for too-short string', () => {
    expect(normalizeCurrencyToken('AB')).toBeUndefined()
  })

  it('strips surrounding whitespace before matching', () => {
    expect(normalizeCurrencyToken(' EUR ')).toBe('EUR')
  })

  it('returns undefined for non-alpha 3-char string', () => {
    expect(normalizeCurrencyToken('12A')).toBeUndefined()
  })

  it('returns undefined for unknown numeric code', () => {
    expect(normalizeCurrencyToken('999')).toBeUndefined()
  })

  it('accepts any 3-letter alpha string (not a whitelist)', () => {
    expect(normalizeCurrencyToken('XYZ')).toBe('XYZ')
    expect(normalizeCurrencyToken('qqq')).toBe('QQQ')
  })
})

describe('uniqueStrings', () => {
  it('deduplicates values', () => {
    expect(uniqueStrings(['a', 'b', 'a'])).toEqual(['a', 'b'])
  })

  it('filters out undefined, empty, and whitespace-only values', () => {
    expect(uniqueStrings([undefined, '', ' ', undefined])).toEqual([])
  })

  it('filters out null when passed via type cast', () => {
    expect(uniqueStrings([null as any, 'a'])).toEqual(['a'])
  })

  it('trims values before deduplicating', () => {
    expect(uniqueStrings([' x ', 'x'])).toEqual(['x'])
  })

  it('preserves insertion order', () => {
    expect(uniqueStrings(['c', 'a', 'b'])).toEqual(['c', 'a', 'b'])
  })

  it('returns empty array for empty input', () => {
    expect(uniqueStrings([])).toEqual([])
  })

  it('handles single element', () => {
    expect(uniqueStrings(['only'])).toEqual(['only'])
  })

  it('handles all-duplicate input', () => {
    expect(uniqueStrings(['x', 'x', 'x'])).toEqual(['x'])
  })
})

describe('trimOrUndefined', () => {
  it('trims a normal string', () => {
    expect(trimOrUndefined('hello')).toBe('hello')
  })

  it('trims leading and trailing whitespace', () => {
    expect(trimOrUndefined(' hello ')).toBe('hello')
  })

  it('returns undefined for empty string', () => {
    expect(trimOrUndefined('')).toBeUndefined()
  })

  it('returns undefined for whitespace-only string', () => {
    expect(trimOrUndefined('   ')).toBeUndefined()
  })

  it('returns undefined for number input', () => {
    expect(trimOrUndefined(123)).toBeUndefined()
  })

  it('returns undefined for null', () => {
    expect(trimOrUndefined(null)).toBeUndefined()
  })

  it('returns undefined for undefined', () => {
    expect(trimOrUndefined(undefined)).toBeUndefined()
  })

  it('returns undefined for object input', () => {
    expect(trimOrUndefined({})).toBeUndefined()
  })
})

describe('isNonEmptyString', () => {
  it('returns true for a non-empty string', () => {
    expect(isNonEmptyString('hello')).toBe(true)
  })

  it('returns true for a string with inner spaces', () => {
    expect(isNonEmptyString('a b')).toBe(true)
  })

  it('returns false for empty string', () => {
    expect(isNonEmptyString('')).toBe(false)
  })

  it('returns false for whitespace-only string', () => {
    expect(isNonEmptyString('  ')).toBe(false)
  })

  it('returns false for tab/newline whitespace', () => {
    expect(isNonEmptyString('\t\n')).toBe(false)
  })

  it.each([
    [123, false],
    [0, false],
    [null, false],
    [undefined, false],
    [true, false],
    [{}, false],
    [[], false]
  ])('returns false for non-string input %j', (input, expected) => {
    expect(isNonEmptyString(input)).toBe(expected)
  })
})

describe('isRecord', () => {
  it('returns true for plain object', () => {
    expect(isRecord({})).toBe(true)
  })

  it('returns true for object with properties', () => {
    expect(isRecord({ a: 1 })).toBe(true)
  })

  it('returns true for array (arrays are objects)', () => {
    expect(isRecord([])).toBe(true)
  })

  it('returns false for null', () => {
    expect(isRecord(null)).toBe(false)
  })

  it.each([
    ['str', false],
    [42, false],
    [true, false],
    [undefined, false]
  ])('returns false for primitive %j', (input, expected) => {
    expect(isRecord(input)).toBe(expected)
  })
})

describe('isAmountObject', () => {
  it('returns true for object with amount property', () => {
    expect(isAmountObject({ amount: 100 })).toBe(true)
  })

  it('returns true for object with amount and currency', () => {
    expect(isAmountObject({ amount: 100, currency: 'USD' })).toBe(true)
  })

  it('returns true for empty object', () => {
    expect(isAmountObject({})).toBe(true)
  })

  it('returns false for array', () => {
    expect(isAmountObject([1, 2])).toBe(false)
  })

  it('returns false for empty array', () => {
    expect(isAmountObject([])).toBe(false)
  })

  it('returns false for null', () => {
    expect(isAmountObject(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isAmountObject(undefined)).toBe(false)
  })

  it.each([
    ['100', false],
    [100, false],
    [true, false]
  ])('returns false for primitive %j', (input, expected) => {
    expect(isAmountObject(input)).toBe(expected)
  })
})

describe('normalizeWhitespace', () => {
  it('collapses multiple spaces into one', () => {
    expect(normalizeWhitespace('a  b   c')).toBe('a b c')
  })

  it('replaces tabs and newlines with spaces', () => {
    expect(normalizeWhitespace('a\tb\nc')).toBe('a b c')
  })

  it('trims leading and trailing whitespace', () => {
    expect(normalizeWhitespace('  hello  ')).toBe('hello')
  })

  it('handles mixed whitespace characters', () => {
    expect(normalizeWhitespace(' \t a \n b \t ')).toBe('a b')
  })

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeWhitespace('   ')).toBe('')
  })

  it('leaves single-spaced text unchanged', () => {
    expect(normalizeWhitespace('already clean')).toBe('already clean')
  })

  it('handles empty string', () => {
    expect(normalizeWhitespace('')).toBe('')
  })
})
