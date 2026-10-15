# SQL05 The Wrong Parcel: answer key (PRIVATE)

Responsible: **Ravi Menon**

**Motive.** To delay the demo and buy time to find the missing calibration sheet.

**Method.** He changed the parcel codes of PX-14 and PX-41 in opposite directions and swapped their destinations before dispatch, so the label-based route sent the sensor module to storage.

**Explanation.** The records support a deliberate label swap and concealment, not theft or damage; the module’s final location is not proven beyond its recorded route to the Storage Bay.

## Timeline
- 15:12: PX-14 is expected at the Demo Desk with the sensor module _(evidence: EX-01)_
- 15:29: Ravi changes PX-14’s parcel code to PX-41 _(evidence: LA-02)_
- 15:31: Ravi changes PX-41’s parcel code to PX-14 _(evidence: LA-03)_
- 15:38: Dispatch scans read labels, not contents _(evidence: RS-01, RS-02)_
- 16:02: Joel receives stage clips at the Demo Desk _(evidence: RC-01)_
- 16:05: The dashboard marks PX-14 delivered to Storage Bay _(evidence: RS-05)_
- 16:07: Ravi tells Sana the demo has to wait while he looks for the calibration sheet _(evidence: MSG-01)_

## Causal chain
1. The right parcels were packed for the right places.
2. Ravi changed both parcel codes in opposite directions and swapped the destinations.
3. The scanner followed the labels, so the dashboard reported a delivery.
4. His message gives the aim: delay until he finds the calibration sheet.

## Questions
- **t1** (t1, CHOICE) THE EXPECTED PARCEL: **A** (PX-14, sensor module). EX-01 expects parcel PX-14 containing the sensor module at the Demo Desk.
- **t2** (t1, CHOICE) WHAT JOEL RECEIVED: **B** (Stage clips in parcel PX-41). RC-01 records stage clips in PX-41 at the Demo Desk, with the expected sensor module absent.
- **t3** (t2, CHOICE) NOT A COURIER MIX-UP: **A** (Reciprocal parcel-code changes on both labels by the same actor before dispatch). The audit shows both parcel codes changed in opposite directions by the same actor before dispatch.
- **t4** (t2, CHOICE) WHY IT SAYS DELIVERED: **A** (The route system follows the swapped label and does not verify contents). The scanner reads labels, not contents, so the dashboard follows the swapped label.
- **t5** (t3, CHOICE) WHO CHANGED THE LABELS: **A** (Ravi Menon). Both reciprocal PARCEL_CODE changes (LA-02, LA-03) name Ravi.
- **t6** (t3, CHOICE) THE BEST EXPLANATION: **A** (Ravi swapped the labels to route the sensor module to storage until he found its calibration sheet, relying on label-based delivery status to obscure the mismatch.). The swap, the route result and Ravi’s calibration-sheet message together point to a deliberate swap meant to buy time.

## Correct final explanation
- Ravi deliberately swapped the labels to route the sensor module to storage until he found its calibration sheet.

## Red herrings
- **Sana Qureshi**: She coordinated the courier handoff and knew about the swap. Innocent because: The audit lists no label change by her, and her messages say she did not edit either label and that scans follow what was printed.
- **Joel D'Souza**: He was the one holding the wrong parcel. Innocent because: His receipt records what arrived at 16:02 and the expected module absent; he reported it at once.
- **Mira Patel**: She requested the delivery and is the team lead. Innocent because: She asked for PX-14 to go to the Demo Desk and was told of the discrepancy; no audit entry or scan names her.
