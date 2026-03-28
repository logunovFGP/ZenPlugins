# BasisBank Plugin Refactor — Parallel Execution Plan

## Goal

Refactor the BasisBank ZenPlugins plugin for consistency, stability, and maintainability by:
1. Extracting duplicated logic into shared utilities
2. Splitting the 1592-line `fetchApi.ts` into cohesive modules
3. Unifying divergent currency validation strategies
4. Eliminating in-place mutations
5. Cleaning dead/redundant type fields
6. Adding test coverage for critical paths
7. Verifying no dead ends via behavior tree analysis

## Current State

| File | Lines | Role |
|------|-------|------|
| `fetchApi.ts` | 1592 | HTTP, auth, account parsing, transaction fetching — 4 responsibilities |
| `converters.ts` | 692 | Transaction/account conversion, date/amount parsing, multi-currency splitting |
| `models.ts` | 135 | All type definitions |
| `index.ts` | 28 | Orchestrator entry point |

## Target State

| File | Lines (est.) | Role |
|------|-------------|------|
| `utils.ts` | ~120 | Shared pure functions: parseNumber, uniqueStrings, currency maps, type guards |
| `http.ts` | ~150 | Request wrapper, header/body helpers, JSON parsing, retry/sleep |
| `auth.ts` | ~350 | Login flow, OTP, trusted device, session lifecycle |
| `accounts.ts` | ~400 | Balance HTML parsing, CardModule accounts, merging, enrichment |
| `transactions.ts` | ~120 | Paged transaction fetching, raw dedup |
| `fetchApi.ts` | ~80 | Thin public API re-exporting orchestrated calls |
| `converters.ts` | ~550 | Transaction/account conversion (imports utils) |
| `models.ts` | ~140 | Types — cleaned + discriminated union for TransactionRow |
| `index.ts` | ~28 | Unchanged orchestrator |

---

## Parallel Execution Waves

### Wave 0: Foundation (Sequential — must complete before all other waves)

**Why sequential**: Every other wave imports from `utils.ts` and `models.ts`. These must exist first.

#### Step 0.1 — Create `utils.ts` (shared pure functions)

**Agent**: `code-simplifier:code-simplifier`
**Input files**: `converters.ts`, `fetchApi.ts`
**Output**: New file `utils.ts`

Extract these duplicated/shared functions:

| Function | Source (keep) | Source (remove) | Notes |
|----------|--------------|-----------------|-------|
| `uniqueStrings()` | converters.ts:4 | fetchApi.ts:1093 | Identical — extract verbatim |
| `parseNumber()` | converters.ts:29 | fetchApi.ts:254 | converters.ts version is more complete (European format, double-dot cleanup, scientific notation). Use that one. |
| `CURRENCY_SYMBOLS` | converters.ts:180 | fetchApi.ts:1037 (`CURRENCY_SYMBOL_MAP`) | Identical data, different names. Keep `CURRENCY_SYMBOLS`. |
| `NUMERIC_TO_ALPHA` | converters.ts:169 | — | Only in converters.ts but logically belongs in shared currency utils |
| `KNOWN_CURRENCIES_SET` | fetchApi.ts:1028 | — | Only in fetchApi.ts but needed by both currency strategies |
| `normalizeCurrencyToken()` | converters.ts:197 | — | Extend to also check `KNOWN_CURRENCIES_SET` for non-3-letter inputs |
| `trimOrUndefined()` | converters.ts:156 | — | Pure utility |
| `isNonEmptyString()` | fetchApi.ts:84 | — | Pure utility |
| `isRecord()` | fetchApi.ts:108 | — | Pure type guard |
| `normalizeWhitespace()` | fetchApi.ts:188 | — | Pure utility |
| `isAmountObject()` | converters.ts:243 | — | Pure type guard |

All functions must be `export`ed. No function should have side effects.

**Currency validation unification**: The single `normalizeCurrencyToken()` in utils.ts must:
1. Check symbol map first (CURRENCY_SYMBOLS)
2. Accept any 3-letter alpha string (matching converters.ts behavior — PSD2 spec allows arbitrary ISO codes)
3. Check numeric codes via NUMERIC_TO_ALPHA
4. Export `KNOWN_CURRENCIES_SET` separately for callers that need whitelist validation (fetchApi's HTML scraping where arbitrary 3-letter words like "THE" appear)

This resolves the divergent validation strategies: converters uses the liberal path (PSD2 data is structured), fetchApi HTML scraping uses the strict path (free text needs whitelist).

#### Step 0.2 — Clean `models.ts` (type definitions)

**Agent**: `code-simplifier:code-simplifier`
**Input files**: `models.ts`, `converters.ts`, `fetchApi.ts` (for usage grep)
**Output**: Modified `models.ts`

Changes:
1. Remove dead fields from `ParsedAccountRow`: `is_card`, `sync_ids`, `currency`, `currency_code` — grep confirms zero usage
2. Split `CardTransactionRow` into discriminated union:

```typescript
interface WebTransactionRow {
  source: 'web'
  // PascalCase CardModule fields only
  TransactionID?: string | number
  TransferID?: string | number
  AccountIban?: string
  // ...
}

interface Psd2TransactionRow {
  source: 'psd2'
  // camelCase PSD2 fields only
  transactionId?: string
  bookingDateTime?: string
  transactionAmount?: { amount?: string | number, currency?: string }
  // ...
}

export type TransactionRow = WebTransactionRow | Psd2TransactionRow
```

3. Add `CookieShape` and `RequestOptions` interfaces (currently private in fetchApi.ts — move to models for reuse across split files)
4. Add `AuthFailureKind` type (currently private in fetchApi.ts)

**Verification**: `tsc --noEmit` must pass after this step (no consumers broken because fields were unused).

---

### Wave 1: Split fetchApi.ts (3 agents in parallel)

**Prerequisite**: Wave 0 complete.

All three agents read from the original `fetchApi.ts` but write to different new files. No conflicts possible.

#### Step 1.1 — Extract `http.ts` (HTTP layer)

**Agent**: `code-simplifier:code-simplifier`
**Scope**: fetchApi.ts lines 1-53, 192-343, 790-841, 929-950

Extract to `http.ts`:
- `normalizeUrlPath()`
- `getHeader()`
- `asStringBody()`
- `parseJsonBody()`
- `parsePossibleJsonContainer()`
- `extractArrayPayloadWithShape()` / `extractArrayPayload()`
- `isDeadSessionPayload()`
- `request()` (the core HTTP wrapper)
- `RequestOptions` interface import from models
- `getMaskedBodyKeys()`
- `formatCardDate()`
- `sleep()`
- `isRetryableTransientError()`
- `RETRYABLE_STATUS_CODES`
- `MAX_TRANSIENT_RETRY_ATTEMPTS`, `BASE_RETRY_DELAY_MS`

All functions `export`ed.

#### Step 1.2 — Extract `auth.ts` (authentication layer)

**Agent**: `code-simplifier:code-simplifier`
**Scope**: fetchApi.ts lines 59-66, 68-178, 345-788

Extract to `auth.ts`:
- `BasisbankAuthError` class
- `parseBooleanPreference()`
- `normalizeStoredDeviceId()`
- `generateDeviceId()`
- `isBasisbankAuthError()`
- Cookie expiry functions: `parseCookieExpiryMs()`, `getCookieExpiryMs()`, `collectAuthExpiryMetadata()`, `getKnownAuthExpiryMs()`, `isAuthExpiryReached()`
- `extractFormFields()`
- `fillDeviceInfoFields()`
- `containsLoginForm()`
- `isOtpRequiredPage()`
- `extractLoginError()`
- `callToolkitSessionId()`
- `requestSmsCode()`
- `readOtpCode()`
- `fetchLoginRedirectPage()`
- `buildLoginForm()`
- `submitLoginForm()`
- `fetchBalancePage()`
- `ensureTrustedDevice()`
- `loginWithOtpFlow()`
- `clearCookieState()`
- `refreshAuthExpiryMetadata()`
- `markSessionAuthorized()`
- `resetSessionState()`
- `checkCardSessionAlive()`
- `authorizeIfNeeded()`
- Constants: `LOGIN_PAGE_PATH`, `BALANCE_PAGE_PATH`, `CARD_PAGE_PATH`, `LOGIN_EVENT_TARGET`, `LOGIN_FIELD`, `PASSWORD_FIELD`, `OTP_FIELD`, `TRUST_*` fields, `OTP_TIMEOUT_MS`, `AUTH_EXPIRY_SKEW_MS`
- `balancePageCache`

Imports from: `http.ts` (request, asStringBody, getHeader, etc.), `utils.ts`, `models.ts`

#### Step 1.3 — Extract `accounts.ts` (account parsing layer)

**Agent**: `code-simplifier:code-simplifier`
**Scope**: fetchApi.ts lines 1027-1479

Extract to `accounts.ts`:
- `parseCurrencyFromText()`
- `parseRowAmounts()`
- `mapCardAccount()`
- `parseBalanceAccountsFromHtml()` — refactored into smaller functions:
  - `extractAccountFromTableRow()` — single row parsing
  - `extractFallbackAccountIds()` — regex scan for statement IDs
  - `deduplicateBalanceAccounts()` — merge duplicates
- `mergeAccounts()`
- `parseCardRowsPayload()`
- `normalizeAccountId()`
- `normalizeAccountKey()`
- `ensureAccountsForTransactions()`

**Immutability fix**: `mergeAccounts()` and `ensureAccountsForTransactions()` must return new arrays/objects instead of mutating inputs. Pattern:

```typescript
// BEFORE (mutates)
existing.id = mapped.id
accounts.push(synthetic)

// AFTER (immutable)
const merged = { ...existing, id: mapped.id, syncIds: uniqueStrings([...]) }
return [...accounts, synthetic]
```

---

### Wave 2: Rewire imports + update converters (2 agents in parallel)

**Prerequisite**: Wave 1 complete.

#### Step 2.1 — Rewrite `fetchApi.ts` as thin orchestrator

**Agent**: `code-simplifier:code-simplifier`

The new `fetchApi.ts` becomes ~80 lines that:
1. Imports and re-exports `initializeSession`, `ensureSessionReady` from `auth.ts`
2. Imports and re-exports `fetchUserAccounts` from `accounts.ts` (which itself calls auth + http)
3. Imports and re-exports `fetchUserTransactions` (calls `transactions.ts` + `accounts.ts`)
4. `index.ts` import paths stay the same (no changes to index.ts)

Also extract `fetchPagedTransactions()` and `callCardModuleWithSessionRetry()` into `transactions.ts` (~120 lines).

#### Step 2.2 — Update `converters.ts` to import from `utils.ts`

**Agent**: `code-simplifier:code-simplifier`

1. Remove local `uniqueStrings()` — import from `utils.ts`
2. Remove local `parseNumber()` — import from `utils.ts`
3. Remove local `CURRENCY_SYMBOLS` — import from `utils.ts`
4. Remove local `NUMERIC_TO_ALPHA` — import from `utils.ts`
5. Remove local `normalizeCurrencyToken()` — import from `utils.ts`
6. Remove local `trimOrUndefined()` — import from `utils.ts`
7. Remove local `isAmountObject()` — import from `utils.ts`
8. Update `isWebRow()` to use discriminated union if Step 0.2 union was adopted, OR keep runtime check if union adds too much migration risk
9. Update `normalizeTransactionCurrency()` to use unified `normalizeCurrencyToken()`

---

### Wave 3: Tests (3 agents in parallel)

**Prerequisite**: Wave 2 complete + `tsc --noEmit` passes.

#### Step 3.1 — Unit tests for `utils.ts`

**Agent**: `tdd-guide`

Test cases for `parseNumber()`:
- Simple integers: `"123"` → `123`
- Negative: `"-45.6"` → `-45.6`
- European format: `"1.234,56"` → `1234.56`
- Bracket negative: `"(100)"` → `-100`
- NBSP: `"1\u00a0234"` → `1234`
- Scientific: `"1.5e3"` → `1500`
- Double-dot: `"1..5"` → `1.5`
- Empty/garbage: `""` → `null`, `"abc"` → `null`
- Already number: `42` → `42`, `NaN` → `null`, `Infinity` → `null`

Test cases for `normalizeCurrencyToken()`:
- Symbol: `"₾"` → `"GEL"`, `"€"` → `"EUR"`
- Alpha: `"usd"` → `"USD"`, `"GEL"` → `"GEL"`
- Numeric: `"978"` → `"EUR"`, `"840"` → `"USD"`
- Invalid: `""` → `undefined`, `"ABCD"` → `undefined`, `"12"` → `undefined`

Test cases for `uniqueStrings()`:
- Dedup: `["a", "b", "a"]` → `["a", "b"]`
- Null/empty: `[undefined, "", " "]` → `[]`
- Trim: `[" x ", "x"]` → `["x"]`

#### Step 3.2 — Unit tests for `accounts.ts`

**Agent**: `tdd-guide`

Test cases for `parseBalanceAccountsFromHtml()`:
- Standard HTML with IBAN, currency, amounts → parsed account
- Missing IBAN → falls back to statement ID
- Multiple currencies in same row → correct extraction
- Fallback regex finds IDs not in table rows
- Duplicate merging: card + non-card → card wins

Test cases for `mergeAccounts()` (immutable version):
- Card row overrides balance row title, balance, currency
- SyncIds merged from both sources
- No mutation of input arrays

Test cases for `ensureAccountsForTransactions()` (immutable version):
- Transaction references unknown account → synthetic created
- Transaction references known account → no synthetic
- Synthetic uses correct ID priority: iban > mainAccountId > encryptedIban

#### Step 3.3 — Unit tests for `converters.ts`

**Agent**: `tdd-guide`

Test cases for `convertTransaction()`:
- Web row (PascalCase fields) → correct amount sign from CreditDebitIndicator
- PSD2 row (camelCase fields) → correct amount from nested transactionAmount
- Missing accountIban → returns null
- Zero amount → returns null (intentional skip)
- Currency mismatch → invoice created vs account instrument
- Merchant dedup: same as description → merchant = null

Test cases for `convertTransactions()` dedup:
- Duplicate movement ID + same account → filtered
- Same content (desc+date+amount) but different IDs → both kept
- Same content, one missing ID → second filtered
- Date range filtering: before fromDate → filtered, after toDate → filtered

Test cases for `splitAccountsByCurrency()`:
- Single currency → account unchanged
- Two currencies → two scoped accounts created with `#EUR`, `#USD` suffix
- Transaction with unknown currency → ignored (no split)

---

### Wave 4: Verification (2 agents in parallel)

**Prerequisite**: Wave 3 complete.

#### Step 4.1 — Code review

**Agent**: `code-reviewer`

Review all modified/created files against:
- No duplicated logic across files (grep for function names defined in >1 file)
- No in-place mutation of function arguments
- All exports properly typed
- No unused imports
- File sizes under 800 lines
- Error handling: no swallowed errors, all throw paths have context

#### Step 4.2 — Behavior tree verification

**Agent**: `architect`

Trace every call path through the plugin to verify no dead ends. See Behavior Tree section below.

---

## Behavior Tree — Call Path Verification

### Entry Point: `scrape()` in index.ts

```
scrape(preferences, fromDate, toDate)
├── initializeSession(preferences, storedAuth)
│   ├── validate login/password → InvalidPreferencesError if empty ✓
│   ├── normalizeStoredDeviceId(storedAuth?.deviceId) → string | undefined ✓
│   └── generateDeviceId() fallback → always produces valid UUID ✓
│
├── ensureSessionReady(session)
│   └── authorizeIfNeeded(session)
│       ├── [login changed?] → forceReauth = true
│       ├── [auth expired?] → forceReauth = true
│       ├── [forceReauth] → resetSessionState() → loginWithOtpFlow()
│       │   ├── fetch login page → TemporaryError if !2xx ✓
│       │   ├── submitLoginForm()
│       │   │   ├── [302 → /Balance.aspx] → fetchBalancePage() → ensureTrustedDevice() → DONE ✓
│       │   │   ├── [302 → /Login.aspx] → fetchLoginRedirectPage() → check OTP ✓
│       │   │   └── [200 + no OTP panel] → extractLoginError() → InvalidLoginOrPasswordError ✓
│       │   ├── [OTP required]
│       │   │   ├── [requestSmsCode=true] → requestSmsCode() → TemporaryError if !2xx ✓
│       │   │   ├── readOtpCode() → InvalidOtpCodeError if empty/timeout ✓
│       │   │   └── submitLoginForm(with OTP)
│       │   │       ├── [302 → /Balance.aspx] → fetchBalancePage() → DONE ✓
│       │   │       ├── [302 → /Info.aspx] → InvalidOtpCodeError ✓
│       │   │       └── [other] → InvalidOtpCodeError ✓
│       │   └── markSessionAuthorized() → updates session.auth ✓
│       │
│       └── [!forceReauth] → restoreCookies() → checkCardSessionAlive()
│           ├── [alive] → fetchBalancePage() → markSessionAuthorized() → DONE ✓
│           │   └── [auth error] → falls through to loginWithOtpFlow() ✓
│           └── [dead] → loginWithOtpFlow() ✓
│
├── ZenMoney.setData('auth') + saveData() ✓
│
├── fetchUserAccounts(session)
│   ├── balancePageCache.get(session) → may have cached HTML ✓
│   │   └── [miss] → fetchBalancePage() → markSessionAuthorized()
│   │       └── [auth error] → authorizeIfNeeded(forceReauth: true) ✓
│   ├── parseBalanceAccountsFromHtml(html) → ParsedAccountRow[] ✓
│   ├── callCardModuleWithSessionRetry('getcardlist')
│   │   ├── [success] → parseCardRowsPayload() ✓
│   │   └── [error] → console.warn, cardRows = [] (graceful degradation) ✓
│   └── mergeAccounts(balanceAccounts, cardRows) → merged list ✓
│
├── fetchUserTransactions(session, fromDate, toDate, accounts)
│   ├── fetchPagedTransactions(booked=false)
│   │   └── [per page] callCardModuleWithSessionRetry('getlasttransactionlist')
│   │       ├── [success, rows > 0] → dedup by ID, accumulate ✓
│   │       ├── [success, rows = 0, page 1, unrecognized format] → TemporaryError ✓
│   │       ├── [success, rows = 0] → break (last page) ✓
│   │       ├── [rows < DEFAULT_PAGE_SIZE_GUESS] → break ✓
│   │       ├── [duplicate page signature] → break ✓
│   │       └── [page > MAX_TRANSACTION_PAGES] → break (safety) ✓
│   │
│   │   callCardModuleWithSessionRetry retry logic:
│   │       ├── [success, not dead session] → return ✓
│   │       ├── [BasisbankAuthError, !sessionRecoveryDone] → authorizeIfNeeded(force) → retry once ✓
│   │       ├── [BasisbankAuthError, sessionRecoveryDone] → TemporaryError ✓
│   │       ├── [retryable transient, attempt < 4] → sleep(backoff) → retry ✓
│   │       ├── [retryable transient, attempt >= 4] → throw ✓
│   │       └── [other error] → throw ✓
│   │
│   ├── fetchPagedTransactions(booked=true) — same tree as above ✓
│   ├── ensureAccountsForTransactions(accounts, all) → synthetic accounts added ✓
│   └── [no meaningful account IDs] → TemporaryError ✓
│
├── splitAccountsByCurrency(apiAccounts, allRows)
│   ├── [single currency per account] → pass through ✓
│   └── [multi currency] → create scoped accounts (id#CCY) ✓
│
├── convertAccounts(splitAccounts) → AccountOrCard[] ✓
│
├── convertTransactions(booked, pending, accounts, fromDate, toDate)
│   ├── buildAccountIndex(accounts) → Map<syncId, AccountOrCard[]> ✓
│   └── [per row]
│       ├── extractAccountIban(row) → undefined → skip ✓
│       ├── resolveAccount(index, iban, currency)
│       │   ├── [no candidates] → skip ✓
│       │   ├── [1 candidate] → use it ✓
│       │   ├── [multi, currency match] → use matched ✓
│       │   └── [multi, no match] → prefer non-suffixed → fallback first ✓
│       ├── ZenMoney.isAccountSkipped(id) → skip ✓
│       ├── extractAmount(row) → null/0 → skip ✓
│       ├── extractDate(row) → Date (never null, falls back to today) ✓
│       ├── [date < fromDate] → skip ✓
│       ├── [date > toDate] → skip ✓
│       ├── primary dedup (movementId+account+sum+date+hold) → skip if seen ✓
│       ├── secondary dedup (content key) → skip if same content+same/empty ID ✓
│       └── emit Transaction ✓
│
├── ZenMoney.setData('auth') + saveData() (second save) ✓
│
└── return { accounts, transactions } ✓
```

### Dead End Analysis

| Path | Verdict | Notes |
|------|---------|-------|
| Login fails silently | **NO DEAD END** | Always throws InvalidLoginOrPasswordError or InvalidOtpCodeError |
| OTP timeout | **NO DEAD END** | readOtpCode() throws InvalidOtpCodeError after OTP_TIMEOUT_MS |
| Session dies mid-fetch | **NO DEAD END** | callCardModuleWithSessionRetry re-auths once, then throws TemporaryError |
| CardModule returns HTML instead of JSON | **NO DEAD END** | containsLoginForm() check → BasisbankAuthError → re-auth |
| Empty account list | **NO DEAD END** | hasMeaningfulAccountIds check → TemporaryError |
| Transaction with no matching account | **NO DEAD END** | resolveAccount returns undefined → transaction skipped |
| All transactions filtered | **OK** | Returns empty array — valid state (no transactions in date range) |
| Trusted device OTP timeout | **NO DEAD END** | readOtpCode() throws InvalidOtpCodeError |
| Cookie restore fails | **NO DEAD END** | console.warn → falls through to loginWithOtpFlow |
| Balance page redirect loop | **POTENTIAL RISK** | fetchBalancePage follows max 1 redirect, then returns/throws. No infinite loop. ✓ |
| Transaction page returns unexpected format | **NO DEAD END** | Page 1 + unrecognized → TemporaryError. Page >1 + empty → break. ✓ |

### Mental Test Scenarios

#### Scenario 1: Fresh install, no stored auth
```
initializeSession: storedAuth=undefined → generateDeviceId() → new session
ensureSessionReady → authorizeIfNeeded(!forceReauth)
  → restoreCookies() fails silently
  → checkCardSessionAlive() → false (no cookies)
  → loginWithOtpFlow() → full login
  → markSessionAuthorized() → saves cookies
RESULT: Works ✓
```

#### Scenario 2: Stored auth, session alive
```
initializeSession: storedAuth={login:'user', deviceId:'xxx', ...} → reuse deviceId
ensureSessionReady → authorizeIfNeeded(!forceReauth)
  → restoreCookies() → success
  → checkCardSessionAlive() → true
  → fetchBalancePage() → success
  → markSessionAuthorized() → update expiry
RESULT: No OTP prompt, fast path ✓
```

#### Scenario 3: Stored auth, session expired mid-transaction-fetch
```
fetchPagedTransactions page 3 → callCardModule → DeadSession
callCardModuleWithSessionRetry:
  → isDeadSessionPayload=true → shouldReauth=true
  → !sessionRecoveryDone → authorizeIfNeeded(forceReauth=true)
  → loginWithOtpFlow() → user enters OTP
  → retry callCardModule → success
RESULT: Recovers with one OTP prompt ✓
```

#### Scenario 4: Multi-currency account (EUR+USD transactions on same IBAN)
```
fetchUserAccounts → account with instrument='' (unknown from HTML)
fetchUserTransactions → transactions have Ccy='EUR' and Ccy='USD'
splitAccountsByCurrency:
  → detects 2 currencies for same accountId
  → creates IBAN#EUR and IBAN#USD
convertAccounts → two AccountOrCard objects
convertTransactions → resolveAccount picks IBAN#EUR for EUR transactions
RESULT: Correct routing ✓
```

#### Scenario 5: Login changed (different user)
```
initializeSession: storedAuth.login='old_user', preferences.login='new_user'
ensureSessionReady → authorizeIfNeeded:
  → session.auth.login !== session.login → forceReauth=true
  → resetSessionState() → clears cookies
  → loginWithOtpFlow() with new credentials
RESULT: Clean re-auth, no stale session contamination ✓
```

#### Scenario 6: Transient 502 during transaction fetch
```
callCardModule → 502 → TemporaryError
isRetryableTransientError → true (message includes '502')
transientAttempt=1 < 4 → sleep(450ms) → retry
[if still 502] → attempt=2 → sleep(900ms) → retry
[if success] → return
[if 4 failures] → throw
RESULT: Exponential backoff with bounded retries ✓
```

#### Scenario 7: Bank returns transactions for account not in account list
```
ensureAccountsForTransactions:
  → transaction.AccountIban not in known set
  → creates synthetic ParsedAccountRow with ID=AccountIban
  → adds to accounts array (must be immutable in refactored version)
splitAccountsByCurrency → may split synthetic if multi-currency
convertAccounts → includes synthetic
convertTransactions → resolveAccount finds it
RESULT: No orphaned transactions ✓
```

---

## Agent Assignment Matrix

| Wave | Step | Agent Type | Files Read | Files Write | Can Parallel With |
|------|------|-----------|------------|-------------|-------------------|
| 0 | 0.1 | `code-simplifier:code-simplifier` | converters.ts, fetchApi.ts | **utils.ts** (new) | — |
| 0 | 0.2 | `code-simplifier:code-simplifier` | models.ts, converters.ts, fetchApi.ts | **models.ts** | Step 0.1 (no file conflict, but models.ts changes should land first or simultaneously) |
| 1 | 1.1 | `code-simplifier:code-simplifier` | fetchApi.ts, utils.ts, models.ts | **http.ts** (new) | Steps 1.2, 1.3 |
| 1 | 1.2 | `code-simplifier:code-simplifier` | fetchApi.ts, http.ts, utils.ts, models.ts | **auth.ts** (new) | Steps 1.1, 1.3 |
| 1 | 1.3 | `code-simplifier:code-simplifier` | fetchApi.ts, http.ts, utils.ts, models.ts | **accounts.ts** (new) | Steps 1.1, 1.2 |
| 2 | 2.1 | `code-simplifier:code-simplifier` | all new files | **fetchApi.ts** (rewrite), **transactions.ts** (new) | Step 2.2 |
| 2 | 2.2 | `code-simplifier:code-simplifier` | converters.ts, utils.ts | **converters.ts** (modify) | Step 2.1 |
| 3 | 3.1 | `tdd-guide` | utils.ts | **__tests__/utils.test.ts** (new) | Steps 3.2, 3.3 |
| 3 | 3.2 | `tdd-guide` | accounts.ts, models.ts | **__tests__/accounts.test.ts** (new) | Steps 3.1, 3.3 |
| 3 | 3.3 | `tdd-guide` | converters.ts, models.ts | **__tests__/converters.test.ts** (new) | Steps 3.1, 3.2 |
| 4 | 4.1 | `code-reviewer` | all files | — (review only) | Step 4.2 |
| 4 | 4.2 | `architect` | all files, this plan | — (analysis only) | Step 4.1 |

**Maximum parallelism**: 3 agents (Wave 1 and Wave 3).

---

## Verification Checklist (Post-Implementation)

### Structural
- [ ] No function defined in more than one file (grep all `function ` declarations)
- [ ] No constant/map defined in more than one file
- [ ] `fetchApi.ts` under 100 lines
- [ ] All other files under 800 lines
- [ ] `index.ts` unchanged (import paths from `./fetchApi` still work)
- [ ] `tsc --noEmit` passes

### Behavioral
- [ ] All 7 mental test scenarios still work (trace through refactored code)
- [ ] `parseNumber()` tests cover both European and US formats
- [ ] Currency normalization: symbol, alpha, numeric, invalid all tested
- [ ] Account merging: card override, syncId merge, immutability
- [ ] Transaction dedup: primary + secondary layers
- [ ] Multi-currency split: single-currency passthrough + multi-split

### No-Regression
- [ ] Zero `as any` casts introduced
- [ ] No new `eslint-disable` or `ts-ignore` comments
- [ ] All error paths throw typed errors (TemporaryError, InvalidLoginOrPasswordError, etc.)
- [ ] No silent catch blocks (all catch blocks either throw, log+continue, or log+fallback)
- [ ] `ZenMoney.setData('auth')` still called exactly twice (after ensureSessionReady + after fetch)
