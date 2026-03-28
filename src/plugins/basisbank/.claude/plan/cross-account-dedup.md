# Plan: Cross-Account Transfer Dedup + Dedup Fixes

## Objective

Fix 3 issues from code review:
1. CRITICAL: Add `groupKeys` for cross-account transfer deduplication
2. HIGH: Fix `contentDedupe` over-filtering when one movement ID is empty
3. HIGH: Fix primary dedup using full ISO timestamp (millisecond drift)

## Affected Files

| File | Operation | Agent |
|------|-----------|-------|
| `converters.ts` | Modify | A |
| `models.ts` | Modify (add TransferType enum if needed) | A |
| `__tests__/converters.test.ts` | Modify — add groupKeys tests | B |
| `__tests__/converters.test.ts` | Modify — add dedup fix tests | B |

## Parallelization

Two agents, no file conflicts:
- **Agent A**: Modifies `converters.ts` and `models.ts`
- **Agent B**: Modifies `__tests__/converters.test.ts`

Agent B can run in parallel because test expectations are defined in this plan.

---

## Agent A: Fix converters.ts

### Change 1: Import ExtendedTransaction

```
FILE: converters.ts
LINE: 1
ACTION: Replace import

BEFORE:
import { AccountOrCard, AccountType, Transaction } from '../../types/zenmoney'

AFTER:
import { AccountOrCard, AccountType, ExtendedTransaction, Transaction } from '../../types/zenmoney'
```

### Change 2: Update convertTransaction return type and add groupKeys

```
FILE: converters.ts
FUNCTION: convertTransaction (currently returns Transaction | null)
ACTION: Change return type to ExtendedTransaction | null, add groupKeys logic

The function currently returns:
  return {
    hold,
    date,
    movements: [ { id: movementId, account: { id: account.id }, ... } ],
    merchant,
    comment: description !== '' ? description : null
  }

ADD groupKeys computation BEFORE the return statement:

  // Cross-account transfer dedup: when TransferID (web) or transactionId (PSD2)
  // is present, use it as groupKey so ZenMoney auto-merges both sides of a transfer.
  // Pattern: Credo-GE, TBC-GE, Bank of Georgia all use this mechanism.
  const groupKey = extractGroupKey(row)

Then change return to:

  return {
    hold,
    date,
    movements: [ ... ],  // unchanged
    merchant,
    comment: description !== '' ? description : null,
    groupKeys: [groupKey]
  }

RETURN TYPE: Change function signature from:
  function convertTransaction (...): Transaction | null
TO:
  function convertTransaction (...): ExtendedTransaction | null
```

### Change 3: Add extractGroupKey helper function

```
FILE: converters.ts
ACTION: Add new function BEFORE convertTransaction

// Extract a stable group key for cross-account transfer matching.
// When the same real-world transfer appears on both sender and receiver accounts,
// both sides share the same TransferID (web) or transactionId (PSD2).
// ZenMoney uses groupKeys to auto-merge them.
// Returns null for non-transfer transactions (no grouping).
function extractGroupKey (row: CardTransactionRow): string | null {
  if (isWebRow(row)) {
    // Web path: TransferID is the canonical transfer identifier.
    // TransactionID is per-account, TransferID is per-transfer.
    const transferId = row.TransferID != null ? String(row.TransferID).trim() : ''
    if (transferId !== '') {
      return transferId
    }
    // Fallback: TransactionReference may link both sides.
    const txnRef = trimOrUndefined(row.TransactionReference)
    if (txnRef != null) {
      return txnRef
    }
    return null
  }
  // PSD2 path: transactionId is shared across both sides of a transfer.
  const psd2Id = trimOrUndefined(row.transactionId)
  if (psd2Id != null) {
    return psd2Id
  }
  // entryReference may also link both sides.
  const entryRef = trimOrUndefined(row.entryReference)
  if (entryRef != null) {
    return entryRef
  }
  return null
}
```

### Change 4: Update convertTransactions return type

```
FILE: converters.ts
FUNCTION: convertTransactions
ACTION: Change return type from Transaction[] to ExtendedTransaction[]

BEFORE:
export function convertTransactions (
  booked: CardTransactionRow[],
  pending: CardTransactionRow[],
  accounts: AccountOrCard[],
  fromDate?: Date,
  toDate?: Date
): Transaction[] {
  ...
  const out: Transaction[] = []

AFTER:
export function convertTransactions (
  booked: CardTransactionRow[],
  pending: CardTransactionRow[],
  accounts: AccountOrCard[],
  fromDate?: Date,
  toDate?: Date
): ExtendedTransaction[] {
  ...
  const out: ExtendedTransaction[] = []
```

### Change 5: Fix contentDedupe over-filtering (HIGH)

```
FILE: converters.ts
FUNCTION: convertTransactions
LOCATION: The secondary dedup block (currently around lines 406-418 after refactor)

BEFORE:
      const previousId = contentDedupe.get(contentKey)
      if (previousId !== undefined) {
        const currentId = movement.id ?? ''
        if (currentId === '' || previousId === '' || currentId === previousId) {
          continue
        }
      }

AFTER:
      const previousId = contentDedupe.get(contentKey)
      if (previousId !== undefined) {
        const currentId = movement.id ?? ''
        // Only filter when BOTH IDs are empty (truly ambiguous) or IDs match exactly.
        // When one has an ID and the other doesn't, they may be different transactions.
        if ((currentId === '' && previousId === '') || currentId === previousId) {
          continue
        }
      }
```

### Change 6: Fix primary dedup timestamp precision (HIGH)

```
FILE: converters.ts
FUNCTION: convertTransactions
LOCATION: The primary dedup key construction

BEFORE:
      const dedupeKey = `${movement.id ?? ''}|${movementAccountId}|${movementSum}|${converted.date.toISOString()}|${String(hold)}`

AFTER:
      // Use Y-m-d date only (not full ISO) to avoid millisecond drift causing duplicates.
      // Matches the secondary dedup's date precision.
      const dedupeKey = `${movement.id ?? ''}|${movementAccountId}|${movementSum}|${dateOnly}|${String(hold)}`

NOTE: dateOnly is already computed a few lines below for contentDedupe.
Move the `const dateOnly = formatDateOnly(converted.date)` line ABOVE the primary dedup key,
so it's available for both.
```

### Change 7: Update index.ts return type compatibility

```
FILE: index.ts
CHECK: index.ts returns { accounts, transactions } where transactions comes from
convertTransactions(). The scrape() return type is ScrapeFunc<Preferences> which
expects { accounts: AccountOrCard[], transactions: Transaction[] }.

ExtendedTransaction extends Transaction, so this is type-compatible.
No change needed in index.ts.

VERIFY by reading the ScrapeFunc type definition.
```

---

## Agent B: Update tests

### Test 1: groupKeys for web transfer

```
FILE: __tests__/converters.test.ts
ADD describe block: 'convertTransactions -- groupKeys'

Test case: Web row with TransferID → groupKeys contains TransferID
  Input: web row with TransferID: '5678', TransactionID: '1234', AccountIban: 'GE...'
  Expected: transaction.groupKeys = ['5678']

Test case: Web row without TransferID → groupKeys contains null
  Input: web row with TransactionID: '1234', no TransferID, AccountIban: 'GE...'
  Expected: transaction.groupKeys = [null]

Test case: PSD2 row with transactionId → groupKeys contains transactionId
  Input: psd2 row with transactionId: 'psd2-tx-001'
  Expected: transaction.groupKeys = ['psd2-tx-001']

Test case: PSD2 row without transactionId → groupKeys contains null
  Input: psd2 row with no transactionId, no entryReference
  Expected: transaction.groupKeys = [null]

Test case: Web row with TransactionReference (no TransferID) → groupKeys uses TransactionReference
  Input: web row with TransactionReference: 'REF-999', no TransferID
  Expected: transaction.groupKeys = ['REF-999']

Test case: Cross-account transfer — same groupKey on both sides
  Input: two web rows with same TransferID '5678' but different AccountIban and opposite amounts
  Expected: both transactions have groupKeys = ['5678']
```

### Test 2: contentDedupe fix

```
FILE: __tests__/converters.test.ts
ADD to existing 'convertTransactions -- dedup' describe block:

Test case: Same content, one ID empty, other has ID → both kept (not filtered)
  Input: two booked rows on same account, same description, same date, same amount
    Row 1: TransactionID: '111'
    Row 2: TransactionID: undefined (will produce hash-based ID)
  Expected: both transactions in output (length 2)

Test case: Same content, both IDs empty → second filtered
  Input: two booked rows on same account, same description, same date, same amount
    Row 1: TransactionID: undefined, TransferID: undefined, TransactionReference: undefined
    Row 2: TransactionID: undefined, TransferID: undefined, TransactionReference: undefined
  Expected: only first transaction in output (length 1)
```

### Test 3: Primary dedup timestamp fix

```
FILE: __tests__/converters.test.ts
ADD to existing 'convertTransactions -- dedup' describe block:

Test case: Same transaction with millisecond date difference → deduped
  Input: two booked rows with same TransactionID, same account, same amount
    Row 1: DocDate: '01/03/2024 10:00:00'
    Row 2: DocDate: '01/03/2024 10:00:01' (1 second difference)
  Expected: only first transaction in output (length 1)
  Rationale: primary dedup now uses Y-m-d only, so both map to '2024-03-01'
```

---

## Execution Order

```
WAVE 1 (parallel):
  Agent A → converters.ts changes 1-6 (+ verify change 7)
  Agent B → __tests__/converters.test.ts tests 1-3

WAVE 2 (sequential):
  Run tests to verify
```

## Verification Checklist

- [ ] `converters.ts` imports `ExtendedTransaction`
- [ ] `convertTransaction()` returns `ExtendedTransaction | null`
- [ ] `convertTransactions()` returns `ExtendedTransaction[]`
- [ ] `extractGroupKey()` exists and handles web + PSD2 paths
- [ ] Web: TransferID > TransactionReference > null
- [ ] PSD2: transactionId > entryReference > null
- [ ] Every returned transaction has `groupKeys: [string | null]`
- [ ] contentDedupe only filters when BOTH IDs empty OR IDs match
- [ ] Primary dedup uses `dateOnly` (Y-m-d) not `toISOString()`
- [ ] `dateOnly` computed before primary dedup key (not after)
- [ ] index.ts type-compatible (ExtendedTransaction extends Transaction)
- [ ] All new tests pass
- [ ] All existing tests still pass
