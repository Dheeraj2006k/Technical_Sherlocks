# SQL06 The Empty Account: answer key (PRIVATE)

Responsible: **Dev Malhotra**

**Motive.** To delay discovery of the changed destination while keeping the appearance that the approved reserve payment was merely retried.

**Method.** After his destination edit on PAY-712 was denied he created PAY-712B, used a successful manual override, reused APR-103 and sent the same ₹12,000 to a different destination fingerprint, then called it a routine retry.

**Explanation.** The records prove a changed destination and a cover story. They do not identify the real-world account holder or what happened to the money after settlement.

## Timeline
- 15:28: Asha creates PAY-712 under APR-103 _(evidence: A1, PAY-712)_
- 15:39: Dev’s attempt to edit the destination of PAY-712 is denied _(evidence: A2)_
- 15:41: The gateway rejects PAY-712 on destination validation _(evidence: G1)_
- 15:42: Dev creates PAY-712B _(evidence: A3, PAY-712B)_
- 15:43: Dev’s manual override succeeds; PAY-712 is reversed _(evidence: A4, G2)_
- 15:44: PAY-712B is accepted to DEST-NORTH-84 _(evidence: G3)_
- 15:50: Dev writes that the replacement was a routine retry _(evidence: N1)_

## Causal chain
1. The original payment was rejected on destination validation and reversed.
2. Dev created a replacement under the same approval and overrode the controls.
3. The replacement went to a different destination fingerprint.
4. His note calls it a routine retry, which the changed fingerprint contradicts.

## Questions
- **t1** (t1, NUMBER) THE GRANT CREDIT: **42000**. Ledger entry L001 credits ₹42,000 for the prototype grant.
- **t2** (t1, TEXT) THE ORIGINAL RESERVE PAYMENT: **PAY-712**. The ₹12,000 emergency equipment reserve debit before the reversal is PAY-712.
- **t3** (t2, TEXT) THE REUSED APPROVAL: **APR-103**. PAY-712B cites APR-103, the same approval as PAY-712.
- **t4** (t2, TEXT) WHO CREATED THE REPLACEMENT: **Dev Malhotra**. PAY-712B was requested by Dev Malhotra, confirmed by the CREATE_REQUEST audit event at 15:42:30 on FIN-02.
- **t5** (t3, TEXT) WHAT CHANGED IN THE TRANSFER: **destination fingerprint**. The original transfer went to DEST-NORTH-44 and the replacement to DEST-NORTH-84, with the same amount and payee.
- **t6** (t3, TEXT) THE AUDIT ACTION: **MANUAL_OVERRIDE**. A successful MANUAL_OVERRIDE by Dev Malhotra on PAY-712B at 15:43 allowed the replacement through.

## Correct final explanation
- Dev created PAY-712B and used a successful manual override to send the same ₹12,000 to a different destination fingerprint (DEST-NORTH-44 became DEST-NORTH-84) under the reused APR-103, then called it a routine retry.

## Red herrings
- **Asha Rao**: She created the original request and used the same approval code. Innocent because: The audit shows she did not create PAY-712B and she logged out of FIN-03 at 15:44:30, after Dev’s FIN-02 activity.
- **Dr Meera Iyer**: APR-103 carries her approval and was reused. Innocent because: The approval covers a payee, a purpose and an amount limit; it was registered at 14:00 for the original destination and does not authorise a changed one.
- **Rohan Das**: He works the gateway and can read the events. Innocent because: His role is checking gateway status and reconciliation timing; no audit event is his, and he has no payment creation permission.
