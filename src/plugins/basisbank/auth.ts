import cheerio from 'cheerio'
import { InvalidLoginOrPasswordError, InvalidOtpCodeError, TemporaryError } from '../../errors'
import { request, asStringBody, getHeader, containsLoginForm, BasisbankAuthError, isBasisbankAuthError } from './http'
import type { FetchResponse } from './http'
import { Auth, CookieShape, Session } from './models'
import { isNonEmptyString, isRecord, normalizeWhitespace } from './utils'
import { callCardModule, checkCardSessionAlive } from './cardModule'

// ─── Constants ───────────────────────────────────────────────────────────────

export const LOGIN_PAGE_PATH = '/Login.aspx'
export const BALANCE_PAGE_PATH = '/Balance.aspx'
// Re-export for consumers that import from auth.ts.
export { CARD_PAGE_PATH } from './cardModule'
export { callCardModule, checkCardSessionAlive }
export { BasisbankAuthError, isBasisbankAuthError }
export const LOGIN_EVENT_TARGET = 'ctl00$ContentPlaceHolder1$LoginLBTN'
export const LOGIN_FIELD = 'ctl00$ContentPlaceHolder1$UTXT'
export const PASSWORD_FIELD = 'ctl00$ContentPlaceHolder1$PTXT'
export const OTP_FIELD = 'ctl00$ContentPlaceHolder1$OptCodeTxt'
export const TRUST_FIRST_CONFIRM_FIELD = 'ctl00$Content$ctl03'
export const TRUST_OTP_FIELD = 'ctl00$Content$TrustedDeviceOTP$TxtOtpCode'
export const TRUST_SECOND_CONFIRM_FIELD = 'ctl00$Content$ctl06'
export const OTP_TIMEOUT_MS = 180000
export const AUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000

// ─── Module-level state ──────────────────────────────────────────────────────

export const balancePageCache = new WeakMap<Session, string>()

// ─── Preference / device helpers ─────────────────────────────────────────────

export function parseBooleanPreference (value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false
    }
  }
  return fallback
}

export function normalizeStoredDeviceId (value: unknown): string | undefined {
  if (!isNonEmptyString(value)) {
    return undefined
  }
  return value.trim()
}

export function generateDeviceId (): string {
  const alphabet = '0123456789abcdef'
  let hex = ''
  for (let i = 0; i < 32; i++) {
    hex += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// ─── Cookie expiry ───────────────────────────────────────────────────────────

export function parseCookieExpiryMs (value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Browser cookies may store seconds since epoch.
    return value > 1e12 ? value : value * 1000
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return undefined
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function getCookieExpiryMs (cookie: unknown): number | undefined {
  if (!isRecord(cookie)) {
    return undefined
  }
  const typed = cookie as CookieShape
  return parseCookieExpiryMs(typed.expires) ??
    parseCookieExpiryMs(typed.expiry) ??
    parseCookieExpiryMs(typed.expirationDate)
}

export function collectAuthExpiryMetadata (cookies: unknown[]): { trustedDeviceExpiresAt?: number, sessionExpiresAt?: number } {
  const now = Date.now()
  const authExpiryCandidates: number[] = []
  let trustedDeviceExpiresAt: number | undefined

  for (const cookie of cookies) {
    if (!isRecord(cookie)) {
      continue
    }
    const name = isNonEmptyString(cookie.name) ? cookie.name.trim() : ''
    const expiresAt = getCookieExpiryMs(cookie)
    if (expiresAt == null || expiresAt <= now) {
      continue
    }

    if (/^TrustedDeviceToken$/i.test(name)) {
      trustedDeviceExpiresAt = expiresAt
    }

    if (/(session|auth|token)/i.test(name)) {
      authExpiryCandidates.push(expiresAt)
    }
  }

  return {
    trustedDeviceExpiresAt,
    sessionExpiresAt: authExpiryCandidates.length > 0 ? Math.min(...authExpiryCandidates) : undefined
  }
}

export function getKnownAuthExpiryMs (auth: Auth): number | undefined {
  const candidates = [auth.sessionExpiresAt, auth.trustedDeviceExpiresAt]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (candidates.length === 0) {
    return undefined
  }
  return Math.min(...candidates)
}

export function isAuthExpiryReached (auth: Auth): boolean {
  const expiresAt = getKnownAuthExpiryMs(auth)
  return expiresAt != null && Date.now() >= expiresAt - AUTH_EXPIRY_SKEW_MS
}

// ─── Form helpers ────────────────────────────────────────────────────────────

export function extractFormFields (html: string): Record<string, string> {
  const $ = cheerio.load(html)
  const fields: Record<string, string> = {}

  $('input[name]').each((_, element) => {
    const input = $(element)
    const name = input.attr('name')
    if (name == null || name === '') {
      return
    }

    const type = (input.attr('type') ?? 'text').toLowerCase()
    if ((type === 'checkbox' || type === 'radio') && input.attr('checked') == null) {
      return
    }

    fields[name] = input.attr('value') ?? ''
  })

  $('select[name]').each((_, element) => {
    const select = $(element)
    const name = select.attr('name')
    if (name == null || name === '') {
      return
    }

    const selected = select.find('option[selected]').first().attr('value')
    const fallback = select.find('option').first().attr('value')
    fields[name] = selected ?? fallback ?? ''
  })

  $('textarea[name]').each((_, element) => {
    const textarea = $(element)
    const name = textarea.attr('name')
    if (name == null || name === '') {
      return
    }
    fields[name] = textarea.text() ?? ''
  })

  return fields
}

export function fillDeviceInfoFields (session: Session, fields: Record<string, string>): void {
  const browserType = 'Chrome'
  const browserVersion = ZenMoney.application?.version != null && ZenMoney.application.version !== ''
    ? ZenMoney.application.version
    : '1.0'
  const platformType = ZenMoney.device?.os?.name != null && ZenMoney.device.os.name !== ''
    ? ZenMoney.device.os.name
    : 'Unknown'
  const platformVersion = ZenMoney.device?.os?.version != null && ZenMoney.device.os.version !== ''
    ? ZenMoney.device.os.version
    : '0'
  const threadCount = '8'
  const gpuInfo = `${ZenMoney.device?.manufacturer ?? 'ZenMoney'} ${ZenMoney.device?.model ?? 'Device'}`
  const stableDeviceId = session.deviceId

  for (const key of Object.keys(fields)) {
    if (/deviceInfoBrowserType$/i.test(key) && fields[key] === '') {
      fields[key] = browserType
    }
    if (/deviceInfoBrowserVersion$/i.test(key) && fields[key] === '') {
      fields[key] = browserVersion
    }
    if (/deviceInfoPlatformType$/i.test(key) && fields[key] === '') {
      fields[key] = platformType
    }
    if (/deviceInfoPlatformVersion$/i.test(key) && fields[key] === '') {
      fields[key] = platformVersion
    }
    if (/deviceInfoThreadCount$/i.test(key) && fields[key] === '') {
      fields[key] = threadCount
    }
    if (/deviceInfoGPUInfo$/i.test(key) && fields[key] === '') {
      fields[key] = gpuInfo
    }
    // BankOnline can bind trust/auth checks to client fingerprint fields.
    if (/(device.*(id|uuid|guid|fingerprint)|fingerprint.*device)/i.test(key) && fields[key] === '') {
      fields[key] = stableDeviceId
    }
  }
}

// ─── Login detection ─────────────────────────────────────────────────────────

export function isOtpRequiredPage (html: string): boolean {
  const $ = cheerio.load(html)
  const otpPanel = $('#ContentPlaceHolder1_OTPP')
  if (otpPanel.length === 0) {
    return false
  }

  const classes = otpPanel.attr('class') ?? ''
  if (!classes.split(/\s+/).includes('hidden')) {
    return true
  }

  const otpBoxFieldClasses = $('#ContentPlaceHolder1_OTPBoXFieldP').attr('class') ?? ''
  if (/\blast\b/i.test(otpBoxFieldClasses) || /\bfilled\b/i.test(otpBoxFieldClasses)) {
    return true
  }

  const safetyHeading = normalizeWhitespace($('#ContentPlaceHolder1_SafetyHeading').text()).toLowerCase()
  if (safetyHeading.includes('additional security') || safetyHeading.includes('დამატებითი უსაფრთხოება')) {
    return true
  }

  return false
}

export function extractLoginError (html: string): string | undefined {
  const $ = cheerio.load(html)
  const candidates = [
    normalizeWhitespace($('#errorfield').text()),
    normalizeWhitespace($('#ContentPlaceHolder1_errorfield').text()),
    normalizeWhitespace($('.errorfield').text()),
    normalizeWhitespace($('.validation-summary-errors').text())
  ].filter(text => text !== '')

  return candidates[0]
}

// ─── Session API calls ───────────────────────────────────────────────────────

export async function callToolkitSessionId (type: 'Login' | 'DeviceBinding'): Promise<void> {
  const response = await request({
    method: 'POST',
    path: `/Handlers/BToolkit.ashx?Action=GetSessionId&Type=${type}`,
    headers: {
      'Content-Type': 'text/plain'
    },
    accept: 'application/json, text/plain, */*',
    refererPath: type === 'Login' ? LOGIN_PAGE_PATH : BALANCE_PAGE_PATH
  })

  if (response.status < 200 || response.status >= 300) {
    console.warn(`[basisbank] BToolkit session init (${type}) returned ${response.status}`)
  }
}

export async function requestSmsCode (refererPath: string): Promise<void> {
  const response = await request({
    method: 'POST',
    path: '/Handlers/SendSms.ashx?Module=BankOnlineTransfer',
    headers: {
      'Content-Type': 'text/plain'
    },
    accept: 'application/json, text/plain, */*',
    refererPath
  })

  if (response.status < 200 || response.status >= 300) {
    throw new TemporaryError(`Could not request BasisBank SMS code (${response.status})`)
  }
}

// ─── OTP ─────────────────────────────────────────────────────────────────────

export async function readOtpCode (prompt: string): Promise<string> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const code = await Promise.race<string | null>([
    ZenMoney.readLine(prompt, {
      inputType: 'number',
      time: OTP_TIMEOUT_MS
    }),
    new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => resolve(null), OTP_TIMEOUT_MS)
    })
  ])
  if (timeoutId != null) {
    clearTimeout(timeoutId)
  }

  if (code == null || code.trim() === '') {
    throw new InvalidOtpCodeError('BasisBank OTP code was not provided in time')
  }

  return code.trim()
}

// ─── Login flow ──────────────────────────────────────────────────────────────

export async function fetchLoginRedirectPage (location: string): Promise<string> {
  const redirected = await request({
    method: 'GET',
    path: location,
    refererPath: LOGIN_PAGE_PATH,
    redirect: 'manual'
  })

  const redirectedLocation = getHeader(redirected, 'Location')
  if (redirected.status === 302 && redirectedLocation != null) {
    const secondRedirected = await request({
      method: 'GET',
      path: redirectedLocation,
      refererPath: LOGIN_PAGE_PATH
    })
    return asStringBody(secondRedirected)
  }

  return asStringBody(redirected)
}

export function buildLoginForm (formFields: Record<string, string>, login: string, password: string, otpCode?: string): Record<string, string> {
  const payload = { ...formFields }
  payload.__EVENTTARGET = LOGIN_EVENT_TARGET
  payload.__EVENTARGUMENT = ''
  payload[LOGIN_FIELD] = login
  payload[PASSWORD_FIELD] = password
  payload[OTP_FIELD] = otpCode ?? ''
  return payload
}

export async function submitLoginForm (
  formFields: Record<string, string>,
  login: string,
  password: string,
  otpCode?: string
): Promise<{ response: FetchResponse, html: string, location?: string }> {
  const payload = buildLoginForm(formFields, login, password, otpCode)
  const response = await request({
    method: 'POST',
    path: LOGIN_PAGE_PATH,
    form: payload,
    redirect: 'manual',
    refererPath: LOGIN_PAGE_PATH,
    sanitizeBodyKeys: [LOGIN_FIELD, PASSWORD_FIELD, OTP_FIELD]
  })

  return {
    response,
    html: asStringBody(response),
    location: getHeader(response, 'Location')
  }
}

// ─── Balance page ────────────────────────────────────────────────────────────

export async function fetchBalancePage (): Promise<string> {
  const response = await request({
    method: 'GET',
    path: BALANCE_PAGE_PATH,
    refererPath: LOGIN_PAGE_PATH,
    redirect: 'manual'
  })

  const location = getHeader(response, 'Location')
  if (response.status === 302 && location != null) {
    if (/\/Login\.aspx/i.test(location)) {
      throw new BasisbankAuthError('balance-login-form', 'BasisBank web session is not authorized')
    }
    const redirected = await request({
      method: 'GET',
      path: location,
      refererPath: BALANCE_PAGE_PATH
    })
    const html = asStringBody(redirected)
    if (containsLoginForm(html)) {
      throw new BasisbankAuthError('balance-login-form', 'BasisBank web session is not authorized')
    }
    return html
  }

  if ([401, 403, 440].includes(response.status)) {
    throw new BasisbankAuthError('balance-login-form', `Could not authorize BasisBank balance page (${response.status})`)
  }

  if (response.status < 200 || response.status >= 300) {
    throw new TemporaryError(`Could not open BasisBank balance page (${response.status})`)
  }

  const html = asStringBody(response)
  if (containsLoginForm(html)) {
    throw new BasisbankAuthError('balance-login-form', 'BasisBank web session is not authorized')
  }

  return html
}

// ─── Trusted device ──────────────────────────────────────────────────────────

export async function ensureTrustedDevice (session: Session, balanceHtml: string): Promise<string> {
  if (!session.trustDevice) {
    return balanceHtml
  }

  if (!balanceHtml.includes('TrustedDevice') && !balanceHtml.includes(TRUST_FIRST_CONFIRM_FIELD)) {
    return balanceHtml
  }

  const firstFields = extractFormFields(balanceHtml)
  fillDeviceInfoFields(session, firstFields)

  if (!(TRUST_FIRST_CONFIRM_FIELD in firstFields)) {
    return balanceHtml
  }

  try {
    await callToolkitSessionId('DeviceBinding')
  } catch (error) {
    console.warn('[basisbank] trusted-device toolkit call failed', error)
  }

  firstFields[TRUST_FIRST_CONFIRM_FIELD] = 'Yes'

  const firstResponse = await request({
    method: 'POST',
    path: BALANCE_PAGE_PATH,
    form: firstFields,
    refererPath: BALANCE_PAGE_PATH,
    sanitizeBodyKeys: [TRUST_FIRST_CONFIRM_FIELD]
  })

  if (firstResponse.status < 200 || firstResponse.status >= 300) {
    throw new TemporaryError(`BasisBank trusted-device step 1 failed (${firstResponse.status})`)
  }

  const secondHtml = asStringBody(firstResponse)
  const secondFields = extractFormFields(secondHtml)
  fillDeviceInfoFields(session, secondFields)

  const otpFieldName = Object.keys(secondFields).find(key => /TrustedDeviceOTP\$TxtOtpCode$/i.test(key)) ?? TRUST_OTP_FIELD
  const confirmFieldName = Object.keys(secondFields).find(key => /\$ctl06$/i.test(key)) ?? TRUST_SECOND_CONFIRM_FIELD

  if (!(otpFieldName in secondFields) || !(confirmFieldName in secondFields)) {
    return secondHtml
  }

  if (session.requestSmsCode) {
    await requestSmsCode(BALANCE_PAGE_PATH)
  }

  const otp = await readOtpCode('Enter BasisBank trusted-device confirmation code')
  secondFields[otpFieldName] = otp
  secondFields[confirmFieldName] = 'Yes'

  const finalResponse = await request({
    method: 'POST',
    path: BALANCE_PAGE_PATH,
    form: secondFields,
    refererPath: BALANCE_PAGE_PATH,
    sanitizeBodyKeys: [otpFieldName]
  })

  if (finalResponse.status < 200 || finalResponse.status >= 300) {
    throw new TemporaryError(`BasisBank trusted-device step 2 failed (${finalResponse.status})`)
  }

  return asStringBody(finalResponse)
}

// ─── Login orchestration ─────────────────────────────────────────────────────

export async function loginWithOtpFlow (session: Session): Promise<string> {
  const loginPage = await request({ method: 'GET', path: LOGIN_PAGE_PATH, refererPath: LOGIN_PAGE_PATH })
  if (loginPage.status < 200 || loginPage.status >= 300) {
    throw new TemporaryError(`Could not open BasisBank login page (${loginPage.status})`)
  }

  const initialHtml = asStringBody(loginPage)
  const initialFields = extractFormFields(initialHtml)
  fillDeviceInfoFields(session, initialFields)

  try {
    await callToolkitSessionId('Login')
  } catch (error) {
    console.warn('[basisbank] login toolkit call failed', error)
  }

  const firstAttempt = await submitLoginForm(initialFields, session.login, session.password)
  const firstLocation = firstAttempt.location ?? ''
  let firstAttemptHtml = firstAttempt.html

  if (firstAttempt.response.status === 302 && /\/Balance\.aspx/i.test(firstLocation)) {
    let balanceHtml = await fetchBalancePage()
    balanceHtml = await ensureTrustedDevice(session, balanceHtml)
    await ZenMoney.saveCookies()
    return balanceHtml
  }

  if (firstAttempt.response.status === 302 && /\/Login\.aspx/i.test(firstLocation)) {
    firstAttemptHtml = await fetchLoginRedirectPage(firstLocation)
  }

  if (!isOtpRequiredPage(firstAttemptHtml)) {
    const explicitError = extractLoginError(firstAttemptHtml)
    const fallback = explicitError ?? 'BasisBank login failed. Verify login/password and OTP requirements.'
    throw new InvalidLoginOrPasswordError(fallback)
  }

  if (session.requestSmsCode) {
    await requestSmsCode(LOGIN_PAGE_PATH)
  }

  const otpCode = await readOtpCode('Enter BasisBank one-time code')
  const otpFields = extractFormFields(firstAttemptHtml)
  fillDeviceInfoFields(session, otpFields)

  const secondAttempt = await submitLoginForm(otpFields, session.login, session.password, otpCode)
  const secondLocation = secondAttempt.location ?? ''

  if (secondAttempt.response.status !== 302 || !/\/(Balance|Info)\.aspx/i.test(secondLocation)) {
    throw new InvalidOtpCodeError('BasisBank did not accept OTP code')
  }

  if (/\/Info\.aspx/i.test(secondLocation)) {
    throw new InvalidOtpCodeError('BasisBank rejected OTP code or requires repeated confirmation')
  }

  let balanceHtml = await fetchBalancePage()
  balanceHtml = await ensureTrustedDevice(session, balanceHtml)
  await ZenMoney.saveCookies()
  return balanceHtml
}

// ─── Session lifecycle ───────────────────────────────────────────────────────

export async function clearCookieState (): Promise<void> {
  try {
    await ZenMoney.clearCookies()
  } catch (error) {
    console.warn('[basisbank] could not clear cookie storage', error)
  }
}

export async function refreshAuthExpiryMetadata (session: Session): Promise<void> {
  try {
    const cookies = await ZenMoney.getCookies()
    if (!Array.isArray(cookies)) {
      return
    }
    const metadata = collectAuthExpiryMetadata(cookies)
    session.auth.sessionExpiresAt = metadata.sessionExpiresAt
    session.auth.trustedDeviceExpiresAt = metadata.trustedDeviceExpiresAt
  } catch (error) {
    console.warn('[basisbank] could not read cookie expiry metadata', error)
  }
}

export async function markSessionAuthorized (session: Session, balanceHtml: string): Promise<string> {
  balancePageCache.set(session, balanceHtml)
  session.auth.login = session.login
  session.auth.deviceId = session.deviceId
  session.auth.lastSuccessfulLoginAt = Date.now()
  await refreshAuthExpiryMetadata(session)
  return balanceHtml
}

export async function resetSessionState (session: Session): Promise<void> {
  await clearCookieState()
  balancePageCache.delete(session)
  session.auth.lastSuccessfulLoginAt = undefined
  session.auth.sessionExpiresAt = undefined
  session.auth.trustedDeviceExpiresAt = undefined
}

// ─── Auth entry point ────────────────────────────────────────────────────────

export async function authorizeIfNeeded (session: Session, { forceReauth = false }: { forceReauth?: boolean } = {}): Promise<string> {
  const loginChanged = session.auth.login != null && session.auth.login !== session.login
  const authExpired = isAuthExpiryReached(session.auth)
  if (authExpired) {
    console.warn('[basisbank] stored auth metadata is expired/near-expired; forcing re-auth')
  }
  const shouldForceReauth = forceReauth || loginChanged || authExpired

  if (shouldForceReauth) {
    await resetSessionState(session)
  } else {
    try {
      await ZenMoney.restoreCookies()
    } catch (error) {
      console.warn('[basisbank] restoreCookies failed', error)
    }
  }

  if (!shouldForceReauth) {
    const alive = await checkCardSessionAlive()
    if (alive) {
      try {
        const cached = await fetchBalancePage()
        return await markSessionAuthorized(session, cached)
      } catch (error) {
        if (!isBasisbankAuthError(error)) {
          throw error
        }
        console.warn('[basisbank] balance page requires re-auth despite alive session check')
      }
    }
  }

  const balanceHtml = await loginWithOtpFlow(session)
  return await markSessionAuthorized(session, balanceHtml)
}
