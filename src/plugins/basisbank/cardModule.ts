// CardModule AJAX calls — extracted from auth.ts for cohesion.
// These are HTTP-layer concerns (calling the BasisBank CardModule handler),
// not auth-state concerns.

import { TemporaryError } from '../../errors'
import {
  request, asStringBody, getHeader, parseJsonBody,
  containsLoginForm, isDeadSessionPayload, BasisbankAuthError
} from './http'

export const CARD_PAGE_PATH = '/Products/Cards/Default.aspx'

export async function callCardModule (funq: string, form: Record<string, string>): Promise<unknown> {
  const response = await request({
    method: 'POST',
    path: `/Handlers/CardModule.ashx?funq=${encodeURIComponent(funq)}`,
    form,
    accept: 'application/json, text/javascript, */*; q=0.01',
    refererPath: CARD_PAGE_PATH,
    headers: {
      'X-Requested-With': 'XMLHttpRequest'
    },
    redirect: 'manual'
  })

  // Data-importer: CardModule 302 redirect handling (GetTransactionsRequest lines 1614-1684).
  // Follow the redirect, check the body for DeadSession/login form.
  if (response.status === 302) {
    const location = getHeader(response, 'Location')
    if (location != null && /\/Login\.aspx/i.test(location)) {
      throw new BasisbankAuthError('cardmodule-login-form', `CardModule redirected to login (${funq})`)
    }
    if (location == null || location.trim() === '') {
      throw new BasisbankAuthError('cardmodule-status', `CardModule returned 302 with empty location (${funq})`)
    }
    const redirected = await request({
      method: 'GET',
      path: location,
      accept: 'application/json, text/javascript, */*; q=0.01',
      refererPath: CARD_PAGE_PATH,
      headers: {
        'X-Requested-With': 'XMLHttpRequest'
      }
    })
    if ([401, 403, 440].includes(redirected.status)) {
      throw new BasisbankAuthError('cardmodule-status', `CardModule auth required after redirect (${funq}, ${redirected.status})`)
    }
    const redirectBody = asStringBody(redirected).trim()
    if (isDeadSessionPayload(redirectBody)) {
      throw new BasisbankAuthError('dead-session', `CardModule session expired after redirect (${funq})`)
    }
    if (redirectBody.startsWith('<') && containsLoginForm(redirectBody)) {
      throw new BasisbankAuthError('cardmodule-login-form', `CardModule session is not authorized after redirect (${funq})`)
    }
    if (redirectBody === '' || redirectBody.toLowerCase() === 'null') {
      return null
    }
    return parseJsonBody(redirected, `CardModule:${funq}`)
  }

  if ([401, 403, 440].includes(response.status)) {
    throw new BasisbankAuthError('cardmodule-status', `CardModule auth required (${funq}, ${response.status})`)
  }

  if (response.status < 200 || response.status >= 300) {
    throw new TemporaryError(`CardModule request failed (${funq}, ${response.status})`)
  }

  const bodyText = asStringBody(response).trim()
  // Data-importer: checks for DeadSession in body BEFORE login form check (line 3021).
  if (isDeadSessionPayload(bodyText)) {
    throw new BasisbankAuthError('dead-session', `CardModule session expired (${funq})`)
  }
  if (bodyText.startsWith('<') && containsLoginForm(bodyText)) {
    throw new BasisbankAuthError('cardmodule-login-form', `CardModule session is not authorized (${funq})`)
  }

  return parseJsonBody(response, `CardModule:${funq}`)
}

export async function checkCardSessionAlive (): Promise<boolean> {
  try {
    const payload = await callCardModule('checksession', {})
    return !isDeadSessionPayload(payload)
  } catch (error) {
    return false
  }
}
