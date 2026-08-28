#!/usr/bin/env bash
# Phase 6: scoped attendance policies with effective dates, IP restriction,
# attendance -> timesheet integration, pay-period data and team scoping.
#
# Self-contained and repeatable: it creates its own policies, removes them at
# the end, and restores the company baseline it started with.
set -u

B=http://localhost:5173/api/v1
J='Content-Type: application/json'
DIR=$(mktemp -d); cd "$DIR" || exit 1
PASS=0; FAIL=0

ev() { node -e "let _b='';process.stdin.on('data',c=>_b+=c).on('end',()=>{try{const j=JSON.parse(_b);$1}catch(e){console.log('ERR:'+e.message)}})"; }
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; PASS=$((PASS+1)); else echo "  FAIL  $1 - expected $2, got $3"; FAIL=$((FAIL+1)); fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

policy() { node -e "
  const base=JSON.parse(process.argv[1]);
  const patch=JSON.parse(process.argv[2]);
  process.stdout.write(JSON.stringify({...base,...patch}));
" "$BASELINE" "$1"; }
setbaseline() { curl -s -o /dev/null -w '%{http_code}' -b a.txt -X PATCH $B/company/attendance-policy -H "$J" -d "$(policy "$1")"; }

echo "################ LOGINS ################"
for pair in "a.txt:admin@hrms.local:Admin@12345" "m.txt:manager@hrms.local:Manager@12345" "e.txt:employee@hrms.local:Employee@12345"; do
  jar=${pair%%:*}; rest=${pair#*:}; em=${rest%%:*}; pw=${rest#*:}
  check "login $em" 200 "$(curl -s -c "$jar" -X POST $B/auth/login -H "$J" -d "{\"email\":\"$em\",\"password\":\"$pw\"}" -o /dev/null -w '%{http_code}')"
done

COMPANY=$(curl -s -b a.txt "$B/company")
BASELINE=$(echo "$COMPANY" | ev "const d=j.data;console.log(JSON.stringify({weekendDays:d.weekendDays,graceMinutes:d.graceMinutes,halfDayMinutes:d.halfDayMinutes,fullDayMinutes:d.fullDayMinutes,earlyLeaveGraceMinutes:d.earlyLeaveGraceMinutes,overtimeEnabled:d.overtimeEnabled,overtimeAfterMinutes:d.overtimeAfterMinutes,overtimeDailyCapMinutes:d.overtimeDailyCapMinutes,locationRestrictionEnabled:d.locationRestrictionEnabled,defaultGeofenceRadiusM:d.defaultGeofenceRadiusM,ipRestrictionEnabled:d.ipRestrictionEnabled,allowedCheckInCidrs:d.allowedCheckInCidrs||[]}))")
ORIGINAL=$BASELINE

# These assertions are written in UTC wall-clock terms: a 09:20Z check-in
# against an 09:00 shift is 20 minutes late only if the company works to UTC.
# The zone is now a real input to the calculation, so the suite states the one
# it assumes rather than inheriting whatever is configured, and restores it.
company_profile() { curl -s -b a.txt "$B/company" | ev "const d=j.data;console.log(JSON.stringify({name:d.name,legalName:d.legalName,email:d.email,phone:d.phone,website:d.website,addressLine1:d.addressLine1,addressLine2:d.addressLine2,city:d.city,state:d.state,postalCode:d.postalCode,country:d.country,timezone:d.timezone,currency:d.currency,dateFormat:d.dateFormat,weekStartsOn:d.weekStartsOn}))"; }
set_timezone() { node -e "const p=JSON.parse(process.argv[1]);p.timezone=process.argv[2];process.stdout.write(JSON.stringify(p))" "$(company_profile)" "$1" > tzbody.json; curl -s -o /dev/null -w '%{http_code}' -b a.txt -X PATCH $B/company -H "$J" --data-binary @tzbody.json; rm -f tzbody.json; }
TZ_ORIGINAL=$(curl -s -b a.txt "$B/company" | ev "console.log(j.data.timezone)")
set_timezone UTC > /dev/null
echo "  INFO  timezone pinned to UTC for this suite (was $TZ_ORIGINAL)"
echo "  INFO  baseline: $BASELINE"

TODAY_UTC=$(curl -s -b a.txt "$B/attendance/today" | ev "console.log(j.data.date)")
KWAME=$(curl -s -b a.txt "$B/employees?q=Kwame&limit=1" | ev "console.log(j.data[0].id)")
TOMAS=$(curl -s -b a.txt "$B/employees?q=Tomas&limit=1" | ev "console.log(j.data[0].id)")
KDEPT=$(curl -s -b a.txt "$B/employees/$KWAME" | ev "console.log(j.data.department?j.data.department.id:'')")
GENERAL=$(curl -s -b a.txt "$B/shifts?limit=20" | ev "const s=j.data.find(x=>x.name==='General');console.log(s.id)")
echo "  INFO  today=$TODAY_UTC Kwame=$KWAME dept=$KDEPT"

# Kwame keeps the 09:00-18:00 shift so late/early have a reference point.
curl -s -o /dev/null -b a.txt -X POST $B/shifts/assignments -H "$J" \
  -d "{\"employeeId\":\"$KWAME\",\"shiftId\":\"$GENERAL\",\"effectiveFrom\":\"2026-01-01\"}"

D=2026-08-05
post_day() { curl -s -b a.txt -X POST $B/attendance -H "$J" \
  -d "{\"employeeId\":\"$KWAME\",\"date\":\"$D\",\"checkInAt\":\"${D}T$1:00Z\",\"checkOutAt\":\"${D}T$2:00Z\"}" > /dev/null; }
read_day() { curl -s -b a.txt "$B/attendance?employeeId=$KWAME&from=$D&to=$D&limit=1" | ev "const r=j.data[0];console.log(r?$1:'missing')"; }

# Remove policies left by an earlier run so every run starts from the baseline.
for PID in $(curl -s -b a.txt "$B/attendance-policies?limit=100" | ev "console.log(j.data.filter(p=>/^P6 /.test(p.name)).map(p=>p.id).join(' '))"); do
  curl -s -o /dev/null -b a.txt -X DELETE "$B/attendance-policies/$PID"
done

echo
echo "################ A. POLICY CRUD AND VALIDATION ################"
check "list policies" 200 "$(code -b a.txt "$B/attendance-policies")"
check "employee may read policies, as they already read /company" 200 "$(code -b e.txt "$B/attendance-policies")"
check "employee cannot create a policy" 403 "$(code -b e.txt -X POST $B/attendance-policies -H "$J" -d '{"name":"P6 Nope","graceMinutes":0,"halfDayMinutes":100,"fullDayMinutes":200,"earlyLeaveGraceMinutes":0,"overtimeAfterMinutes":200,"overtimeDailyCapMinutes":60}')"
check "employee cannot assign a policy" 403 "$(code -b e.txt -X POST $B/attendance-policies/assignments -H "$J" -d '{"policyId":"x","scope":"COMPANY","effectiveFrom":"2026-01-01"}')"
check "manager cannot create a policy" 403 "$(code -b m.txt -X POST $B/attendance-policies -H "$J" -d '{"name":"P6 Rogue","graceMinutes":0,"halfDayMinutes":100,"fullDayMinutes":200,"earlyLeaveGraceMinutes":0,"overtimeAfterMinutes":200,"overtimeDailyCapMinutes":60}')"
check "half-day above full-day rejected" 422 "$(code -b a.txt -X POST $B/attendance-policies -H "$J" -d '{"name":"P6 Bad","graceMinutes":0,"halfDayMinutes":600,"fullDayMinutes":300,"earlyLeaveGraceMinutes":0,"overtimeAfterMinutes":300,"overtimeDailyCapMinutes":60}')"

STRICT=$(curl -s -b a.txt -X POST $B/attendance-policies -H "$J" -d '{"name":"P6 Strict","description":"No grace at all.","graceMinutes":0,"halfDayMinutes":240,"fullDayMinutes":480,"earlyLeaveGraceMinutes":0,"overtimeEnabled":true,"overtimeAfterMinutes":480,"overtimeDailyCapMinutes":240,"isActive":true}' | ev "console.log(j.data?j.data.id:'')")
check "admin creates a policy" true "$([ -n "$STRICT" ] && echo true || echo false)"
check "duplicate name rejected" 409 "$(code -b a.txt -X POST $B/attendance-policies -H "$J" -d '{"name":"P6 Strict","graceMinutes":0,"halfDayMinutes":240,"fullDayMinutes":480,"earlyLeaveGraceMinutes":0,"overtimeAfterMinutes":480,"overtimeDailyCapMinutes":240}')"

RELAXED=$(curl -s -b a.txt -X POST $B/attendance-policies -H "$J" -d '{"name":"P6 Relaxed","graceMinutes":60,"halfDayMinutes":120,"fullDayMinutes":240,"earlyLeaveGraceMinutes":120,"overtimeEnabled":false,"overtimeAfterMinutes":480,"overtimeDailyCapMinutes":240,"isActive":true}' | ev "console.log(j.data?j.data.id:'')")
check "second policy created" true "$([ -n "$RELAXED" ] && echo true || echo false)"

echo
echo "################ B. BASELINE APPLIES WHEN NOTHING IS ASSIGNED ################"
setbaseline '{"graceMinutes":10}' > /dev/null
check "no override in force" null "$(curl -s -b a.txt "$B/attendance-policies/effective?employeeId=$KWAME" | ev "console.log(JSON.stringify(j.data.policyId))")"
check "grace comes from the baseline" 10 "$(curl -s -b a.txt "$B/attendance-policies/effective?employeeId=$KWAME" | ev "console.log(j.data.graceMinutes)")"
check "check-in 09:20 is 20 late under the baseline grace of 10" 20 "$(post_day 09:20 18:00; read_day "r.lateMinutes")"

echo
echo "################ C. DEPARTMENT OVERRIDE ################"
DASG=$(curl -s -b a.txt -X POST $B/attendance-policies/assignments -H "$J" -d "{\"policyId\":\"$RELAXED\",\"scope\":\"DEPARTMENT\",\"targetId\":\"$KDEPT\",\"effectiveFrom\":\"2026-01-01\"}" | ev "console.log(j.data?j.data.id:'')")
check "assign relaxed policy to the department" true "$([ -n "$DASG" ] && echo true || echo false)"
check "effective policy is now the override" "P6 Relaxed" "$(curl -s -b a.txt "$B/attendance-policies/effective?employeeId=$KWAME" | ev "console.log(j.data.policyName)")"
check "reported at department scope" DEPARTMENT "$(curl -s -b a.txt "$B/attendance-policies/effective?employeeId=$KWAME" | ev "console.log(j.data.scope)")"
check "grace 60 forgives a 20-minute arrival" 0 "$(post_day 09:20 18:00; read_day "r.lateMinutes")"
check "overtime disabled by the override" 0 "$(post_day 08:00 19:00; read_day "r.overtimeMinutes")"
check "full day 240 makes a 300-minute day PRESENT" PRESENT "$(post_day 09:00 14:00; read_day "r.status")"

echo
echo "################ D. MOST SPECIFIC WINS ################"
EASG=$(curl -s -b a.txt -X POST $B/attendance-policies/assignments -H "$J" -d "{\"policyId\":\"$STRICT\",\"scope\":\"EMPLOYEE\",\"targetId\":\"$KWAME\",\"effectiveFrom\":\"2026-01-01\"}" | ev "console.log(j.data?j.data.id:'')")
check "assign strict policy to the individual" true "$([ -n "$EASG" ] && echo true || echo false)"
check "employee override beats department" "P6 Strict" "$(curl -s -b a.txt "$B/attendance-policies/effective?employeeId=$KWAME" | ev "console.log(j.data.policyName)")"
check "reported at employee scope" EMPLOYEE "$(curl -s -b a.txt "$B/attendance-policies/effective?employeeId=$KWAME" | ev "console.log(j.data.scope)")"
check "grace 0 makes the same arrival 20 late" 20 "$(post_day 09:20 18:00; read_day "r.lateMinutes")"
check "colleague outside the override keeps the baseline" null "$(curl -s -b a.txt "$B/attendance-policies/effective?employeeId=$TOMAS" | ev "console.log(JSON.stringify(j.data.policyId))")"

echo
echo "################ E. EFFECTIVE DATES KEEP HISTORY HONEST ################"
# The strict policy only starts in September, so an August day must still be
# scored by what was in force in August.
curl -s -o /dev/null -b a.txt -X DELETE "$B/attendance-policies/assignments/$EASG"
FUTURE=$(curl -s -b a.txt -X POST $B/attendance-policies/assignments -H "$J" -d "{\"policyId\":\"$STRICT\",\"scope\":\"EMPLOYEE\",\"targetId\":\"$KWAME\",\"effectiveFrom\":\"2026-09-01\"}" | ev "console.log(j.data?j.data.id:'')")
check "future-dated assignment created" true "$([ -n "$FUTURE" ] && echo true || echo false)"
check "as at 5 Aug the department policy still applies" "P6 Relaxed" "$(curl -s -b a.txt "$B/attendance-policies/effective?employeeId=$KWAME&on=2026-08-05" | ev "console.log(j.data.policyName)")"
check "as at 15 Sep the strict policy applies" "P6 Strict" "$(curl -s -b a.txt "$B/attendance-policies/effective?employeeId=$KWAME&on=2026-09-15" | ev "console.log(j.data.policyName)")"
check "rescoring an August day uses the August policy" 0 "$(post_day 09:20 18:00; read_day "r.lateMinutes")"
check "end date closes an assignment" 201 "$(code -b a.txt -X POST $B/attendance-policies/assignments -H "$J" -d "{\"policyId\":\"$RELAXED\",\"scope\":\"EMPLOYEE\",\"targetId\":\"$TOMAS\",\"effectiveFrom\":\"2026-01-01\",\"effectiveTo\":\"2026-01-31\"}")"
check "and it does not apply after that date" null "$(curl -s -b a.txt "$B/attendance-policies/effective?employeeId=$TOMAS&on=2026-06-01" | ev "console.log(JSON.stringify(j.data.policyId))")"
check "but does apply inside it" "P6 Relaxed" "$(curl -s -b a.txt "$B/attendance-policies/effective?employeeId=$TOMAS&on=2026-01-15" | ev "console.log(j.data.policyName)")"
check "end before start rejected" 422 "$(code -b a.txt -X POST $B/attendance-policies/assignments -H "$J" -d "{\"policyId\":\"$RELAXED\",\"scope\":\"COMPANY\",\"effectiveFrom\":\"2026-06-01\",\"effectiveTo\":\"2026-01-01\"}")"
check "missing target for a scoped assignment rejected" 422 "$(code -b a.txt -X POST $B/attendance-policies/assignments -H "$J" -d "{\"policyId\":\"$RELAXED\",\"scope\":\"TEAM\",\"effectiveFrom\":\"2026-06-01\"}")"
check "unknown target rejected" 422 "$(code -b a.txt -X POST $B/attendance-policies/assignments -H "$J" -d "{\"policyId\":\"$RELAXED\",\"scope\":\"TEAM\",\"targetId\":\"does-not-exist\",\"effectiveFrom\":\"2026-06-01\"}")"

echo
echo "################ F. EFFECTIVE-POLICY SCOPE SECURITY ################"
check "unauth cannot read effective policy" 401 "$(code "$B/attendance-policies/effective?employeeId=$KWAME")"
check "employee cannot read another employee's policy" 403 "$(code -b e.txt "$B/attendance-policies/effective?employeeId=$KWAME")"
check "manager cannot read an out-of-scope policy" 403 "$(code -b m.txt "$B/attendance-policies/effective?employeeId=$KWAME")"
check "employee can read their own" 200 "$(code -b e.txt "$B/attendance-policies/effective?employeeId=$TOMAS")"

echo
echo "################ G. IP RESTRICTION ################"
check "enabling with an empty list is rejected" 422 "$(setbaseline '{"ipRestrictionEnabled":true,"allowedCheckInCidrs":[]}')"
check "a malformed network is rejected" 422 "$(setbaseline '{"ipRestrictionEnabled":true,"allowedCheckInCidrs":["not-an-address"]}')"
check "restriction off: today does not ask" false "$(setbaseline '{"ipRestrictionEnabled":false}' >/dev/null; curl -s -b e.txt $B/attendance/today | ev "console.log(j.data.networkRestricted)")"
WORKING=$(curl -s -b e.txt "$B/attendance/today" | ev "console.log(j.data.isWorkingDay)")
clear_today() { curl -s -o /dev/null -b a.txt -X POST $B/attendance -H "$J" -d "{\"employeeId\":\"$TOMAS\",\"date\":\"$TODAY_UTC\",\"status\":\"ABSENT\"}"; }
if [ "$WORKING" != "true" ]; then
  echo "  SKIP  today is not a working day, so the capture path cannot be exercised"
else
  clear_today
  check "check-in allowed with the restriction off" 201 "$(code -b e.txt -X POST $B/attendance/check-in -H "$J" -d '{"mode":"OFFICE"}')"
  check "restriction on with a non-matching network" 200 "$(setbaseline '{"ipRestrictionEnabled":true,"allowedCheckInCidrs":["203.0.113.0/24"]}')"
  check "today now reports the restriction" true "$(curl -s -b e.txt $B/attendance/today | ev "console.log(j.data.networkRestricted)")"
  check "the allow-list is never sent to the browser" true "$(curl -s -b e.txt $B/attendance/today | ev "console.log(!('allowedCheckInCidrs' in j.data))")"
  clear_today
  check "check-in from outside the allow-list is refused" 403 "$(code -b e.txt -X POST $B/attendance/check-in -H "$J" -d '{"mode":"OFFICE"}')"
  check "remote mode cannot bypass it" 403 "$(code -b e.txt -X POST $B/attendance/check-in -H "$J" -d '{"mode":"REMOTE"}')"
  echo "  INFO  now allowing loopback, which is where these requests come from"
  setbaseline '{"ipRestrictionEnabled":true,"allowedCheckInCidrs":["127.0.0.0/8","::1"]}' > /dev/null
  clear_today
  check "check-in from an approved network succeeds" 201 "$(code -b e.txt -X POST $B/attendance/check-in -H "$J" -d '{"mode":"OFFICE"}')"
  setbaseline '{"ipRestrictionEnabled":false,"allowedCheckInCidrs":[]}' > /dev/null
fi

echo
echo "################ H. ATTENDANCE -> TIMESHEET ################"
# A period with known attendance: 3-7 Aug 2026 (Mon-Fri).
TS_START=2026-08-17; TS_END=2026-08-21
# Timesheets have no delete route by design - approved time should not vanish -
# so scripts/reset-audit-fixtures.mjs clears this period before a rerun.
# Give the period two complete days and one with no check-out.
curl -s -o /dev/null -b a.txt -X POST $B/attendance -H "$J" -d "{\"employeeId\":\"$KWAME\",\"date\":\"2026-08-17\",\"checkInAt\":\"2026-08-17T09:00:00Z\",\"checkOutAt\":\"2026-08-17T18:00:00Z\"}"
curl -s -o /dev/null -b a.txt -X POST $B/attendance -H "$J" -d "{\"employeeId\":\"$KWAME\",\"date\":\"2026-08-18\",\"checkInAt\":\"2026-08-18T09:00:00Z\",\"checkOutAt\":\"2026-08-18T17:00:00Z\"}"
curl -s -o /dev/null -b a.txt -X POST $B/attendance -H "$J" -d "{\"employeeId\":\"$KWAME\",\"date\":\"2026-08-20\",\"checkInAt\":\"2026-08-20T09:00:00Z\"}"

TS=$(curl -s -b a.txt -X POST $B/timesheets -H "$J" -d "{\"employeeId\":\"$KWAME\",\"periodStart\":\"$TS_START\",\"periodEnd\":\"$TS_END\",\"entries\":[{\"date\":\"2026-08-21\",\"minutes\":120,\"description\":\"Manual: offsite training\"}]}" | ev "console.log(j.data?j.data.id:'')")
check "timesheet created with a manual entry" true "$([ -n "$TS" ] && echo true || echo false)"

SYNC=$(curl -s -b a.txt -X POST "$B/timesheets/$TS/sync-attendance" -H "$J" -d '{"replaceExisting":true}')
echo "  INFO  sync: $(echo "$SYNC" | ev "console.log(JSON.stringify(j.data))")"
check "two complete days written" 2 "$(echo "$SYNC" | ev "console.log(j.data.entriesWritten)")"
check "the day with no check-out is skipped, not guessed" 1 "$(echo "$SYNC" | ev "console.log(j.data.skippedIncomplete)")"
check "the manual entry is kept" 1 "$(echo "$SYNC" | ev "console.log(j.data.manualEntriesKept)")"
check "captured minutes are 540+480" 1020 "$(echo "$SYNC" | ev "console.log(j.data.capturedMinutes)")"
check "manual minutes stay separate" 120 "$(echo "$SYNC" | ev "console.log(j.data.manualMinutes)")"
check "total is captured plus manual" 1140 "$(echo "$SYNC" | ev "console.log(j.data.totalMinutes)")"
check "entries carry their source" true "$(curl -s -b a.txt "$B/timesheets/$TS" | ev "const e=j.data.entries;console.log(e.some(x=>x.source==='CAPTURED')&&e.some(x=>x.source==='MANUAL'))")"
check "captured entries link back to attendance" true "$(curl -s -b a.txt "$B/timesheets/$TS" | ev "console.log(j.data.entries.filter(x=>x.source==='CAPTURED').every(x=>x.attendanceRecordId))")"
echo "-- re-syncing is idempotent --"
SYNC2=$(curl -s -b a.txt -X POST "$B/timesheets/$TS/sync-attendance" -H "$J" -d '{"replaceExisting":true}')
check "same total after a second sync" 1140 "$(echo "$SYNC2" | ev "console.log(j.data.totalMinutes)")"
check "manual entry still there" 1 "$(echo "$SYNC2" | ev "console.log(j.data.manualEntriesKept)")"
echo "-- a corrected attendance day flows through on the next sync --"
curl -s -o /dev/null -b a.txt -X POST $B/attendance -H "$J" -d "{\"employeeId\":\"$KWAME\",\"date\":\"2026-08-18\",\"checkInAt\":\"2026-08-18T09:00:00Z\",\"checkOutAt\":\"2026-08-18T18:00:00Z\"}"
SYNC3=$(curl -s -b a.txt -X POST "$B/timesheets/$TS/sync-attendance" -H "$J" -d '{"replaceExisting":true}')
check "corrected day raises the captured total" 1080 "$(echo "$SYNC3" | ev "console.log(j.data.capturedMinutes)")"
echo "-- only the owner may submit, so ownership is proved first --"
check "an administrator cannot submit someone else's timesheet" 403 "$(code -b a.txt -X POST "$B/timesheets/$TS/submit")"
ADMINEMP=$(curl -s -b a.txt "$B/employees?q=Dev&limit=1" | ev "console.log(j.data[0].id)")
OWNTS=$(curl -s -b a.txt -X POST $B/timesheets -H "$J" -d "{\"employeeId\":\"$ADMINEMP\",\"periodStart\":\"$TS_START\",\"periodEnd\":\"$TS_END\",\"entries\":[]}" | ev "console.log(j.data?j.data.id:'')")
check "administrator creates their own timesheet" true "$([ -n "$OWNTS" ] && echo true || echo false)"
check "and can submit it" 200 "$(code -b a.txt -X POST "$B/timesheets/$OWNTS/submit")"
check "syncing a submitted timesheet is refused" 409 "$(code -b a.txt -X POST "$B/timesheets/$OWNTS/sync-attendance" -H "$J" -d '{}')"
check "employee cannot sync an out-of-scope timesheet" 403 "$(code -b e.txt -X POST "$B/timesheets/$TS/sync-attendance" -H "$J" -d '{}')"

echo
echo "################ I. PAY-PERIOD DATA ################"
PP=$(curl -s -b a.txt "$B/attendance/pay-period?from=$TS_START&to=$TS_END")
echo "  INFO  totals: $(echo "$PP" | ev "console.log(JSON.stringify(j.data.totals))")"
check "period echoed back" "$TS_START" "$(echo "$PP" | ev "console.log(j.data.from)")"
check "a row per employee in scope" true "$(echo "$PP" | ev "console.log(j.data.rows.length>=11)")"
KROW="const r=j.data.rows.find(x=>x.employeeId==='$KWAME');"
check "worked minutes aggregated" 1080 "$(echo "$PP" | ev "$KROW console.log(r.workedMinutes)")"
check "regular plus overtime equals worked" true "$(echo "$PP" | ev "$KROW console.log(r.regularMinutes + r.overtimeMinutes === r.workedMinutes)")"
check "the incomplete day is flagged" 1 "$(echo "$PP" | ev "$KROW console.log(r.incompleteDays)")"
check "administrator adjustments are counted" true "$(echo "$PP" | ev "$KROW console.log(r.adjustedDays>0)")"
check "weekend days reported" 0 "$(echo "$PP" | ev "$KROW console.log(r.weekendDays)")"
check "employee sees only themselves" 1 "$(curl -s -b e.txt "$B/attendance/pay-period?from=$TS_START&to=$TS_END" | ev "console.log(j.data.rows.length)")"
check "employee cannot target another" 403 "$(code -b e.txt "$B/attendance/pay-period?from=$TS_START&to=$TS_END&employeeId=$KWAME")"
check "manager cannot target out of scope" 403 "$(code -b m.txt "$B/attendance/pay-period?from=$TS_START&to=$TS_END&employeeId=$KWAME")"
check "unauth refused" 401 "$(code "$B/attendance/pay-period?from=$TS_START&to=$TS_END")"
check "an oversized period is refused" 422 "$(code -b a.txt "$B/attendance/pay-period?from=2026-01-01&to=2026-12-31")"

echo
echo "################ J. TEAM FILTERS STAY INSIDE SCOPE ################"
check "admin can filter by department" true "$(curl -s -b a.txt "$B/attendance/team?departmentId=$KDEPT&limit=50" | ev "console.log(j.data.every(r=>r.departmentName!==null))")"
check "department filter narrows the list" true "$(curl -s -b a.txt "$B/attendance/team?departmentId=$KDEPT&limit=50" | ev "console.log(j.meta.total<12)")"
check "manager filtering by a foreign department gets nothing extra" true "$(curl -s -b m.txt "$B/attendance/team?departmentId=$KDEPT&limit=50" | ev "console.log(j.data.every(r=>r.employeeId!=='$KWAME'))")"
# The filter can only ever remove rows from what the scope already allows.
# Tomas is not in Kwame's department, so filtering by it leaves him nothing -
# it cannot reach across into a department he has no access to.
check "employee filtering by a foreign department gets nothing" 0 "$(curl -s -b e.txt "$B/attendance/team?departmentId=$KDEPT&limit=50" | ev "console.log(j.meta.total)")"
TDEPT=$(curl -s -b a.txt "$B/employees/$TOMAS" | ev "console.log(j.data.department?j.data.department.id:'')")
check "employee filtering by their own department still sees only themselves" 1 "$(curl -s -b e.txt "$B/attendance/team?departmentId=$TDEPT&limit=50" | ev "console.log(j.meta.total)")"
check "unknown team yields an empty list, not an error" 0 "$(curl -s -b a.txt "$B/attendance/team?teamId=nope&limit=50" | ev "console.log(j.meta.total)")"

echo
echo "################ K. EXISTING BEHAVIOUR STILL HOLDS ################"
check "shift still resolves on the record" General "$(curl -s -b a.txt "$B/attendance?employeeId=$KWAME&from=$D&to=$D&limit=1" | ev "console.log(j.data[0].shiftName)")"
check "unassigned employee keeps null lateness" null "$(SOFIA=$(curl -s -b a.txt "$B/employees?q=Sofia&limit=1" | ev "console.log(j.data[0].id)"); curl -s -o /dev/null -b a.txt -X POST $B/attendance -H "$J" -d "{\"employeeId\":\"$SOFIA\",\"date\":\"$D\",\"checkInAt\":\"${D}T09:20:00Z\",\"checkOutAt\":\"${D}T18:00:00Z\"}"; curl -s -b a.txt "$B/attendance?employeeId=$SOFIA&from=$D&to=$D&limit=1" | ev "console.log(JSON.stringify(j.data[0].lateMinutes))")"
check "weekend derivation unaffected" WEEKEND "$(curl -s -b a.txt "$B/attendance/summary?employeeId=$KWAME&from=2026-08-08&to=2026-08-08" | ev "console.log(j.data.days[0].status)")"
check "absence marking still idempotent" 0 "$(curl -s -o /dev/null -b a.txt -X POST $B/attendance/mark-absences -H "$J" -d "{\"date\":\"2026-08-12\"}"; curl -s -b a.txt -X POST $B/attendance/mark-absences -H "$J" -d "{\"date\":\"2026-08-12\"}" | ev "console.log(j.data.marked)")"

echo
echo "################ RESTORE ################"
check "timezone restored" 200 "$(set_timezone "$TZ_ORIGINAL")"
curl -s -o /dev/null -b a.txt -X DELETE "$B/attendance-policies/$STRICT"
curl -s -o /dev/null -b a.txt -X DELETE "$B/attendance-policies/$RELAXED"
check "policies removed" 0 "$(curl -s -b a.txt "$B/attendance-policies?limit=100" | ev "console.log(j.data.filter(p=>/^P6 /.test(p.name)).length)")"
check "assignments went with them" 0 "$(curl -s -b a.txt "$B/attendance-policies/assignments?limit=100" | ev "console.log(j.data.filter(a=>/^P6 /.test(a.policyName)).length)")"
check "employee falls back to the baseline" null "$(curl -s -b a.txt "$B/attendance-policies/effective?employeeId=$KWAME" | ev "console.log(JSON.stringify(j.data.policyId))")"
BASELINE=$ORIGINAL
check "baseline restored" 200 "$(setbaseline '{}')"

echo
echo "################ SUMMARY ################"
echo "PASS=$PASS  FAIL=$FAIL"
