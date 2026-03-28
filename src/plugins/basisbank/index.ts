import { ScrapeFunc } from '../../types/zenmoney'
import { ensureSessionReady, fetchUserAccounts, fetchUserTransactions, initializeSession } from './fetchApi'
import { convertAccounts, convertTransactions, splitAccountsByCurrency } from './converters'
import { Auth, Preferences } from './models'

export const scrape: ScrapeFunc<Preferences> = async ({ preferences, fromDate, toDate }) => {
  toDate = toDate ?? new Date()
  const session = initializeSession(preferences, ZenMoney.getData('auth') as Auth | undefined)
  await ensureSessionReady(session)
  ZenMoney.setData('auth', session.auth)
  ZenMoney.saveData()

  const apiAccounts = await fetchUserAccounts(session)
  const apiTransactions = await fetchUserTransactions(session, fromDate, toDate, apiAccounts)

  // Split multi-currency accounts before conversion (matching data-importer's splitAccountsByCurrency).
  // Use enriched accounts (includes synthetic accounts discovered from transactions).
  const allRows = [...apiTransactions.booked, ...apiTransactions.pending]
  const splitAccounts = splitAccountsByCurrency(apiTransactions.accounts, allRows)

  const accounts = convertAccounts(splitAccounts)
  const transactions = convertTransactions(apiTransactions.booked, apiTransactions.pending, accounts, fromDate, toDate)

  // Session/auth metadata may be refreshed during account/transaction fetch.
  ZenMoney.setData('auth', session.auth)
  ZenMoney.saveData()

  return { accounts, transactions }
}
