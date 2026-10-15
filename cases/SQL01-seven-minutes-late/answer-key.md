# SQL01 Seven Minutes Late: answer key (PRIVATE)

Responsible: **Rohit Kulkarni**

**Motive.** He needed the Pulse wall at full brightness for the 10 PM demonstration and had no spare module.

**Method.** After reading the high-severity DO NOT POWER warning at 20:49 and finding no spare, he restored power to Module 04 at a real 21:32 through the rear loading door. Arjun later entered by the main door and was shocked diagnosing the powered cabinet.

**Explanation.** Reckless, knowing conduct: he knew the unit was unsafe and powered it anyway. The records do not support an intentional attack.

## Timeline
- 20:43: Kavya powers Module 04 off (controller reads 20:43, already the reference time) _(evidence: P1, W3)_
- 20:46: Kavya files MR-184: connector too hot, DO NOT POWER _(evidence: MR-184)_
- 20:49: Rohit opens the warning _(evidence: NA-1)_
- 21:26: Rohit finds no spare module _(evidence: RT2, E4)_
- 21:28: Priya reminds Rohit of the full-brightness demo; he answers "Give me ten minutes" at 21:30 _(evidence: RM2, RM3)_
- 21:32: Controller shows ON at 21:29 (3 minutes slow) and the rear-door camera shows motion at displayed 21:36 (4 minutes fast) _(evidence: P2, C9)_
- 21:38: Arjun enters the main workshop door _(evidence: W8)_
- 21:52: Overcurrent fault; Arjun found unconscious _(evidence: P3, F8)_

## Causal chain
1. Module 04 was reported unsafe and Rohit read the warning.
2. There was no spare and the demo was due at 10 PM.
3. After correcting the clocks the controller ON and the rear-door motion are the same real minute.
4. The rear door generates no RFID event, so no workshop entry exists for the person who restored power.

## Questions
- **t1** (t1, NUMBER) WHO WAS STILL THERE: **5**. Five Team Pulse members (Nikhil, Sameer, Arjun, Rohit and Kavya) appear in the workshop, equipment and fest activity records after 21:20.
- **t2** (t1, TEXT) MAIN WORKSHOP RFID ENTRIES: **Arjun Varma, Nikhil Reddy, Sameer Khan**. Only Nikhil (21:21), Sameer (21:34) and Arjun (21:38) have main-door RFID ENTRY events between 21:20 and the 21:52 discovery; Mahesh’s 21:52 entry is not a Team Pulse member.
- **t3** (t2, TEXT) THE SEMINAR HALL ALIBI: **Nikhil Reddy**. Nikhil’s laptop activity (21:42 to 21:48) and the fest badge and network records (21:43 and 21:44) are separate systems that both place him in Seminar Hall 2.
- **t4** (t2, TEXT) THE OFFICIAL REPORT: **Kavya Iyer; disconnect and do not power Module 04**. MR-184 was filed by Kavya Iyer at 20:46: connector above safe temperature, unit disconnected, DO NOT POWER.
- **t5** (t3, TIME) SEVEN MINUTES LATE: **21:32**. The controller shows ON at 21:29 and its clock is 3 minutes slow, so the real time is 21:32.
- **t6** (t3, TEXT) THE DOOR WITHOUT A BADGE: **Rear Loading Door**. The Rear Loading Door uses a mechanical latch and generates no RFID event, which is why a person using it leaves no workshop entry.

## Correct final explanation
- Rohit knowingly restored power to Module 04 after reading the do-not-power warning, to save the 10 PM demo; the corrected controller and rear-door camera times both land on 21:32, and Arjun was shocked later while diagnosing it. It was reckless, not an intentional attack.

## Red herrings
- **Nikhil Reddy**: He argued with Arjun and has a workshop entry close to Arjun’s last entry. Innocent because: He left the workshop at 21:27, eleven minutes before Arjun entered at 21:38, and his laptop and badge records place him in Seminar Hall 2 from 21:42.
- **Kavya Iyer**: She worked on Module 04 and reported it. Innocent because: She disconnected it at 20:43 and left, filed the warning, and her stage console logs put her in the Main Auditorium at 20:50 and 21:47.
- **Sameer Khan**: He was in the workshop in the minutes before Arjun entered. Innocent because: He collected the soldering station, his entry and exit match the camera once its 4 minute offset is removed, and no controller event is his.
