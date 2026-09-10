# Leaves Data_2026.xlsx — import assessment (dry run only, nothing written)

Date: 2026-09-10. Backup: backups/hrms_prod-preleaveimport-20260910-192745.dump (60 tables, verified).

## Verdict

The workbook is a **monthly leave-count summary**, not a leave register. It carries no
dates, no leave types, no reasons, no statuses and no approver information, so it cannot
produce `leave_requests` rows without inventing four NOT NULL columns. No import proposed.

## 1. Sheets and columns

Sheet "Leaves Data": 992 declared rows, 80 with content. Row 1 = merged month bands,
row 2 = sub-headers, rows 3-80 = 78 employees.
Sheet "Sheet1": no header, same 43-column shape, 6 employees, none of whom appear in
"Leaves Data". Sr# 34 and 41 are missing from the main sheet; Sheet1 holds Sr# 41.

Columns: Sr# | Employee ID | Employee name | Reporting Manager | then 12 months x
(Late, Half Day, Leave) | Total Leaves | Total Leave Remaining | Comments.

## 2. Excel -> HRMS mapping

| Excel column | HRMS field | Status |
|---|---|---|
| Employee ID | employees.employeeNumber | usable, with caveats (section 3) |
| Employee name | employees.displayName | corroboration only |
| Reporting Manager | employees.managerId | free text, multi-valued ("Amir / Kaleem / Abdul Rehman"); not importable |
| <Month> Leave | - | count only, no date; cannot become leave_requests |
| <Month> Half Day | leave_requests.dayPart | count only, no date |
| <Month> Late | - | entirely empty in this file |
| Total Leaves | leave_types.annualEntitlementDays | one combined bucket; HRMS has four typed buckets |
| Total Leave Remaining | derived by HRMS | must not be imported; HRMS computes it |
| Comments | - | one row populated (R32) |

Required by `leave_requests` and absent from the file: startDate, endDate, totalDays,
reason, leaveTypeId, status.

## 3. Employee matching (employeeNumber only, never name alone)

84 data rows: 67 clean, 7 ambiguous, 7 unmatched, 3 with no usable ID.

Punch-code hazard is real and present. 30 of 78 HRMS employees have a deviceUserId that
differs from their employeeNumber. Row 10 "Muhammad Awais Zahid" carries ID 26, which is
his punch code; his employeeNumber is 1020. Matching that row on 26 would have written to
the wrong record. No PunchCode mapping was read as an employee identifier.

Ambiguous (ID matches, name disagrees - needs a human):
1023 "Ahsan Arif" vs emp 1023 "Ahsan Mughal"; 1025 "Muhammad Bilal" vs emp 1025 "bilal faqeer";
134 "Muavia Javed" vs "Mavia Javed"; 260 "Sajjad Ali" vs "Sajaad ali"; 273 "Mir Ferjad Ali"
vs "Farjad Ali"; 274 "M.Umair" vs "Muhammad Umair"; 275 "Numan Haider" vs "Nauman Haider".

Unmatched: 26 (punch code of 1020), 788 "Hassan Haider" (name matches emp 213 only),
and Sheet1's 198, 178, 268, 116, 555.
No usable ID: "Sammy" (0), "Falak Sher" (0), "Usman (office boy)" (blank).

## 4-8. Not satisfiable from this file

No dates, so no duplicate detection on employee/date. No status column, so nothing to
preserve and nothing that would justify defaulting to Approved. The sheet's single "Leave"
bucket does not map onto Annual / Casual / Sick / Unpaid; no leave type is proposed.

## 9-10. Production state (unchanged)

employees 80, leave_requests 4 (all QA test rows on ZZ-QA-TEST-001), leave_balances 0,
attendance_records 13393, raw punches 29748, punch mappings 78.
Attendance holds zero ON_LEAVE rows for 2026. Volume in the sheet: 674 leave days,
134 half days, 0 lates across 464 non-zero cells.

Anomalies: Total Leave Remaining is negative for 9 employees (Adeel Ali -38); a stray
Nov Leave of -1 and an Oct Half Day of 0 sit beyond today's date.
