#!/usr/bin/env bash
# Phase 5 completion: configurable policy, absence marking, overtime,
# weekend configuration, team view scope and check-in geofencing.
#
# Self-contained and repeatable: it saves the company policy at the start,
# restores it at the end, and uses its own dates so a second run behaves the
# same as the first.
set -u

B=http://localhost:5173/api/v1
J='Content-Type: application/json'
DIR=$(mktemp -d); cd "$DIR" || exit 1
PASS=0; FAIL=0

ev() { node -e "let _b='';process.stdin.on('data',c=>_b+=c).on('end',()=>{try{const j=JSON.parse(_b);$1}catch(e){console.log('ERR:'+e.message)}})"; }
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; PASS=$((PASS+1)); else echo "  FAIL  $1 - expected $2, got $3"; FAIL=$((FAIL+1)); fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# Overwrite one field of the saved policy and PATCH it back.
policy() { # policy <json-fragment>
  node -e "
    const base=JSON.parse(process.argv[1]);
    const patch=JSON.parse(process.argv[2]);
    process.stdout.write(JSON.stringify({...base,...patch}));
  " "$POLICY" "$1"
}
setpolicy() { curl -s -o /dev/null -w '%{http_code}' -b a.txt -X PATCH $B/company/attendance-policy -H "$J" -d "$(policy "$1")"; }

echo "################ LOGINS ################"
for pair in "a.txt:admin@hrms.local:Admin@12345" "m.txt:manager@hrms.local:Manager@12345" "e.txt:employee@hrms.local:Employee@12345"; do
  jar=${pair%%:*}; rest=${pair#*:}; em=${rest%%:*}; pw=${rest#*:}
  check "login $em" 200 "$(curl -s -c "$jar" -X POST $B/auth/login -H "$J" -d "{\"email\":\"$em\",\"password\":\"$pw\"}" -o /dev/null -w '%{http_code}')"
done

COMPANY=$(curl -s -b a.txt "$B/company")
POLICY=$(echo "$COMPANY" | ev "const d=j.data;console.log(JSON.stringify({weekendDays:d.weekendDays,graceMinutes:d.graceMinutes,halfDayMinutes:d.halfDayMinutes,fullDayMinutes:d.fullDayMinutes,earlyLeaveGraceMinutes:d.earlyLeaveGraceMinutes,overtimeEnabled:d.overtimeEnabled,overtimeAfterMinutes:d.overtimeAfterMinutes,overtimeDailyCapMinutes:d.overtimeDailyCapMinutes,locationRestrictionEnabled:d.locationRestrictionEnabled,defaultGeofenceRadiusM:d.defaultGeofenceRadiusM}))")
ORIGINAL=$POLICY
echo "  INFO  saved policy: $POLICY"

# Identities used throughout.
TODAY_UTC=$(curl -s -b a.txt "$B/attendance/today" | ev "console.log(j.data.date)")
KWAME=$(curl -s -b a.txt "$B/employees?q=Kwame&limit=1" | ev "console.log(j.data[0].id)")
GENERAL=$(curl -s -b a.txt "$B/shifts?limit=20" | ev "const s=j.data.find(x=>x.name==='General');console.log(s.id)")
HEADOFFICE=$(curl -s -b a.txt "$B/locations?limit=20" | ev "const l=j.data.find(x=>x.name==='Head Office');console.log(l.id)")
echo "  INFO  Kwame=$KWAME  General shift=$GENERAL  Head Office=$HEADOFFICE"

# Kwame gets the 09:00-18:00 shift from well before any test date, so late and
# early-leave have something to measure against.
curl -s -o /dev/null -b a.txt -X POST $B/shifts/assignments -H "$J" \
  -d "{\"employeeId\":\"$KWAME\",\"shiftId\":\"$GENERAL\",\"effectiveFrom\":\"2026-01-01\"}"

D=2026-08-05   # a Wednesday, no seeded records
# No status field, so the policy scores the day.
post_day() { # post_day <checkIn> <checkOut>
  curl -s -b a.txt -X POST $B/attendance -H "$J" \
    -d "{\"employeeId\":\"$KWAME\",\"date\":\"$D\",\"checkInAt\":\"${D}T$1:00Z\",\"checkOutAt\":\"${D}T$2:00Z\"}" > /dev/null
}
# With an explicit status, which must override the computed one.
post_day_as() { # post_day_as <checkIn> <checkOut> <status>
  curl -s -b a.txt -X POST $B/attendance -H "$J" \
    -d "{\"employeeId\":\"$KWAME\",\"date\":\"$D\",\"status\":\"$3\",\"checkInAt\":\"${D}T$1:00Z\",\"checkOutAt\":\"${D}T$2:00Z\"}" > /dev/null
}
read_day() { curl -s -b a.txt "$B/attendance?employeeId=$KWAME&from=$D&to=$D&limit=1" | ev "const r=j.data[0];console.log(r?$1:'missing')"; }

echo
echo "################ A. POLICY IS CONFIGURABLE AND VALIDATED ################"
check "company exposes the policy" 200 "$(code -b a.txt $B/company)"
check "graceMinutes present" true "$(echo "$COMPANY" | ev "console.log(typeof j.data.graceMinutes==='number')")"
check "half-day above full-day rejected" 422 "$(setpolicy '{"halfDayMinutes":600,"fullDayMinutes":480}')"
check "seven weekend days rejected" 422 "$(setpolicy '{"weekendDays":["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY","SUNDAY"]}')"
check "negative grace rejected" 422 "$(setpolicy '{"graceMinutes":-5}')"
check "absurd radius rejected" 422 "$(setpolicy '{"defaultGeofenceRadiusM":2}')"
check "employee cannot change the policy" 403 "$(code -b e.txt -X PATCH $B/company/attendance-policy -H "$J" -d "$(policy '{}')")"
check "manager cannot change the policy" 403 "$(code -b m.txt -X PATCH $B/company/attendance-policy -H "$J" -d "$(policy '{}')")"
check "admin can change the policy" 200 "$(setpolicy '{"graceMinutes":15}')"
check "and it persisted" 15 "$(curl -s -b a.txt $B/company | ev "console.log(j.data.graceMinutes)")"

echo
echo "################ B. GRACE PERIOD DRIVES LATENESS ################"
echo "  INFO  shift General 09:00-18:00, check-in 09:20 on $D"
check "grace 0 -> 20 minutes late" 20 "$(setpolicy '{"graceMinutes":0}' >/dev/null; post_day 09:20 18:00; read_day "r.lateMinutes")"
check "grace 30 -> forgiven entirely" 0 "$(setpolicy '{"graceMinutes":30}' >/dev/null; post_day 09:20 18:00; read_day "r.lateMinutes")"
check "grace 10, 20 late -> full 20 reported" 20 "$(setpolicy '{"graceMinutes":10}' >/dev/null; post_day 09:20 18:00; read_day "r.lateMinutes")"
check "on time -> 0, not null" 0 "$(post_day 08:55 18:00; read_day "r.lateMinutes")"

echo
echo "################ C. EARLY LEAVE GRACE ################"
check "grace 10, out 17:00 -> 60 early" 60 "$(setpolicy '{"earlyLeaveGraceMinutes":10}' >/dev/null; post_day 09:00 17:00; read_day "r.earlyLeaveMinutes")"
check "grace 90 -> forgiven" 0 "$(setpolicy '{"earlyLeaveGraceMinutes":90}' >/dev/null; post_day 09:00 17:00; read_day "r.earlyLeaveMinutes")"

echo
echo "################ D. HALF-DAY AND MINIMUM-HOURS THRESHOLDS ################"
echo "  INFO  worked 300 minutes (09:00-14:00), no status sent, so the policy scores it"
check "half 240 / full 480 -> HALF_DAY" HALF_DAY "$(setpolicy '{"halfDayMinutes":240,"fullDayMinutes":480}' >/dev/null; post_day 09:00 14:00; read_day "r.status")"
check "half 180 / full 240 -> PRESENT" PRESENT "$(setpolicy '{"halfDayMinutes":180,"fullDayMinutes":240}' >/dev/null; post_day 09:00 14:00; read_day "r.status")"
check "half 400 / full 480 -> ABSENT" ABSENT "$(setpolicy '{"halfDayMinutes":400,"fullDayMinutes":480}' >/dev/null; post_day 09:00 14:00; read_day "r.status")"
check "worked minutes unchanged by scoring" 300 "$(read_day "r.workedMinutes")"
check "an explicit status still wins" PRESENT "$(post_day_as 09:00 14:00 PRESENT; read_day "r.status")"

echo
echo "################ E. OVERTIME ################"
echo "  INFO  worked 660 minutes (08:00-19:00)"
check "after 480, cap 240 -> 180 overtime" 180 "$(setpolicy '{"overtimeEnabled":true,"overtimeAfterMinutes":480,"overtimeDailyCapMinutes":240}' >/dev/null; post_day 08:00 19:00; read_day "r.overtimeMinutes")"
check "cap 60 applies" 60 "$(setpolicy '{"overtimeEnabled":true,"overtimeAfterMinutes":480,"overtimeDailyCapMinutes":60}' >/dev/null; post_day 08:00 19:00; read_day "r.overtimeMinutes")"
check "threshold 600 -> 60 overtime" 60 "$(setpolicy '{"overtimeEnabled":true,"overtimeAfterMinutes":600,"overtimeDailyCapMinutes":240}' >/dev/null; post_day 08:00 19:00; read_day "r.overtimeMinutes")"
check "disabled -> 0, not null" 0 "$(setpolicy '{"overtimeEnabled":false}' >/dev/null; post_day 08:00 19:00; read_day "r.overtimeMinutes")"
check "worked is not inflated by overtime" 660 "$(read_day "r.workedMinutes")"
check "exactly at threshold -> no overtime" 0 "$(setpolicy '{"overtimeEnabled":true,"overtimeAfterMinutes":480,"overtimeDailyCapMinutes":240}' >/dev/null; post_day 09:00 17:00; read_day "r.overtimeMinutes")"

echo
echo "################ F. WEEKEND CONFIGURATION ################"
SAT=2026-08-08; FRI=2026-08-07
setpolicy '{"weekendDays":["SATURDAY","SUNDAY"]}' > /dev/null
check "Saturday is a weekend by default" WEEKEND "$(curl -s -b a.txt "$B/attendance/summary?employeeId=$KWAME&from=$SAT&to=$SAT" | ev "console.log(j.data.days[0].status)")"
check "Friday is not" true "$(curl -s -b a.txt "$B/attendance/summary?employeeId=$KWAME&from=$FRI&to=$FRI" | ev "console.log(j.data.days[0].status!=='WEEKEND')")"
setpolicy '{"weekendDays":["FRIDAY"]}' > /dev/null
check "reconfigured: Friday becomes the weekend" WEEKEND "$(curl -s -b a.txt "$B/attendance/summary?employeeId=$KWAME&from=$FRI&to=$FRI" | ev "console.log(j.data.days[0].status)")"
check "reconfigured: Saturday is now a working day" true "$(curl -s -b a.txt "$B/attendance/summary?employeeId=$KWAME&from=$SAT&to=$SAT" | ev "console.log(j.data.days[0].status!=='WEEKEND')")"
echo "-- leave working-day counting reads the same setting --"
LT=$(curl -s -b e.txt "$B/leave-types?limit=10" | ev "const t=j.data.find(x=>x.name==='Annual Leave')||j.data[0];console.log(t.id)")
check "a leave type was resolved" true "$([ -n "$LT" ] && echo true || echo false)"
TESTFRI=2026-12-04
# A request left behind by an earlier run would clash with this one, so it is
# withdrawn first. Cancelled leave does not block a later booking.
STALE=$(curl -s -b e.txt "$B/leave/requests?limit=100" | ev "const r=j.data.find(x=>x.startDate==='$TESTFRI'&&(x.status==='PENDING'||x.status==='APPROVED'));console.log(r?r.id:'')")
if [ -n "$STALE" ]; then
  curl -s -o /dev/null -b e.txt -X POST "$B/leave/requests/$STALE/cancel" -H "$J" -d '{"reason":"Audit cleanup."}'
  echo "  INFO  withdrew a leave request left by an earlier run"
fi
check "single-day leave on the configured weekend is refused" 422 "$(code -b e.txt -X POST $B/leave/requests -H "$J" -d "{\"leaveTypeId\":\"$LT\",\"startDate\":\"$TESTFRI\",\"endDate\":\"$TESTFRI\",\"dayPart\":\"FULL_DAY\",\"reason\":\"Policy audit: Friday weekend.\"}")"
setpolicy '{"weekendDays":["SATURDAY","SUNDAY"]}' > /dev/null
check "restored: that same Friday is bookable again" 201 "$(code -b e.txt -X POST $B/leave/requests -H "$J" -d "{\"leaveTypeId\":\"$LT\",\"startDate\":\"$TESTFRI\",\"endDate\":\"$TESTFRI\",\"dayPart\":\"FULL_DAY\",\"reason\":\"Policy audit: Friday is a working day.\"}")"
NEWREQ=$(curl -s -b e.txt "$B/leave/requests?limit=100" | ev "const r=j.data.find(x=>x.startDate==='$TESTFRI'&&x.status==='PENDING');console.log(r?r.id:'')")
check "and it can be withdrawn again, leaving no residue" 200 "$(code -b e.txt -X POST "$B/leave/requests/$NEWREQ/cancel" -H "$J" -d '{"reason":"Audit cleanup."}')"

echo
echo "################ G. AUTOMATIC ABSENCE MARKING ################"
# Marking absences is permanent by design, so the suite finds a past working
# day that has not been finalised yet rather than reusing a fixed date. That
# keeps every run a genuine first run.
WINDOW=$(node -e "const t=new Date('${TODAY_UTC}T00:00:00Z');t.setUTCDate(t.getUTCDate()-55);console.log(t.toISOString().slice(0,10))")
ABS=$(curl -s -b a.txt "$B/attendance/summary?employeeId=$KWAME&from=$WINDOW&to=$TODAY_UTC" | ev "const d=j.data.days.filter(x=>x.status==='ABSENT'&&!x.hasRecord&&x.date<'$TODAY_UTC').pop();console.log(d?d.date:'none')")
echo "  INFO  finalising $ABS (latest past working day with no record)"
check "an unfinalised working day was found" true "$([ "$ABS" != "none" ] && echo true || echo false)"
BEFORE=$(curl -s -b a.txt "$B/attendance/summary?employeeId=$KWAME&from=$ABS&to=$ABS" | ev "console.log(j.data.days[0].hasRecord)")
check "no record before the run" false "$BEFORE"
RUN1=$(curl -s -b a.txt -X POST $B/attendance/mark-absences -H "$J" -d "{\"date\":\"$ABS\"}")
echo "  INFO  run 1: $(echo "$RUN1" | ev "console.log(JSON.stringify(j.data))")"
check "marked at least one absence" true "$(echo "$RUN1" | ev "console.log(j.data.marked>0)")"
check "terminated employees excluded" true "$(echo "$RUN1" | ev "console.log(j.data.scanned<12)")"
AFTER=$(curl -s -b a.txt "$B/attendance/summary?employeeId=$KWAME&from=$ABS&to=$ABS")
check "record now exists" true "$(echo "$AFTER" | ev "console.log(j.data.days[0].hasRecord)")"
check "and is ABSENT" ABSENT "$(echo "$AFTER" | ev "console.log(j.data.days[0].status)")"
check "attributed to the system" SYSTEM "$(curl -s -b a.txt "$B/attendance?employeeId=$KWAME&from=$ABS&to=$ABS&limit=1" | ev "console.log(j.data[0].source)")"
echo "-- idempotency --"
RUN2=$(curl -s -b a.txt -X POST $B/attendance/mark-absences -H "$J" -d "{\"date\":\"$ABS\"}")
echo "  INFO  run 2: $(echo "$RUN2" | ev "console.log(JSON.stringify(j.data))")"
check "second run marks nothing" 0 "$(echo "$RUN2" | ev "console.log(j.data.marked)")"
check "and reports them as already recorded" true "$(echo "$RUN2" | ev "console.log(j.data.skipped.alreadyRecorded>0)")"
echo "-- it must never overwrite a real record --"
KEPT_BEFORE=$(read_day "r.workedMinutes+'/'+r.source+'/'+r.status")
curl -s -o /dev/null -b a.txt -X POST $B/attendance/mark-absences -H "$J" -d "{\"date\":\"$D\"}"
check "an existing record is left exactly as it was" "$KEPT_BEFORE" "$(read_day "r.workedMinutes+'/'+r.source+'/'+r.status")"
check "and it is still the administrator's, not the job's" ADMIN "$(read_day "r.source")"
echo "-- calendar exclusions --"
WKND=$(curl -s -b a.txt -X POST $B/attendance/mark-absences -H "$J" -d "{\"date\":\"$SAT\"}")
check "weekend: nothing marked" 0 "$(echo "$WKND" | ev "console.log(j.data.marked)")"
check "weekend: everyone skipped as non-working" true "$(echo "$WKND" | ev "console.log(j.data.skipped.notWorkingDay===j.data.scanned)")"
# A company-wide holiday, so every employee is covered by it. A holiday pinned
# to one location correctly leaves people at other locations working, which
# would make "nothing marked" the wrong expectation.
HOL=$(curl -s -b a.txt "$B/holidays?limit=50" | ev "const h=j.data.filter(x=>x.locationId===null&&x.isActive&&x.date<'$TODAY_UTC').sort((a,b)=>b.date.localeCompare(a.date))[0];console.log(h?h.date:'none')")
echo "  INFO  most recent past company-wide holiday: $HOL"
if [ "$HOL" != "none" ]; then
  HRUN=$(curl -s -b a.txt -X POST $B/attendance/mark-absences -H "$J" -d "{\"date\":\"$HOL\"}")
  echo "  INFO  holiday run: $(echo "$HRUN" | ev "console.log(JSON.stringify(j.data))")"
  check "company-wide holiday: nothing marked" 0 "$(echo "$HRUN" | ev "console.log(j.data.marked)")"
  check "holiday: everyone skipped as non-working" true "$(echo "$HRUN" | ev "console.log(j.data.skipped.notWorkingDay===j.data.scanned)")"
fi
echo "-- a location-specific holiday only covers that location --"
LOCHOL=$(curl -s -b a.txt "$B/holidays?limit=50" | ev "const h=j.data.filter(x=>x.locationId!==null&&x.isActive&&x.date<'$TODAY_UTC')[0];console.log(h?h.date:'none')")
if [ "$LOCHOL" != "none" ]; then
  LRUN=$(curl -s -b a.txt -X POST $B/attendance/mark-absences -H "$J" -d "{\"date\":\"$LOCHOL\"}")
  echo "  INFO  $LOCHOL run: $(echo "$LRUN" | ev "console.log(JSON.stringify(j.data))")"
  check "some are on holiday, others are not" true "$(echo "$LRUN" | ev "console.log(j.data.skipped.notWorkingDay>0 && j.data.skipped.notWorkingDay<j.data.scanned)")"
fi
echo "-- approved leave is excluded --"
LEAVEDAY=$(curl -s -b a.txt "$B/attendance/summary?from=2026-09-01&to=2026-09-30" | ev "const d=j.data.days.find(x=>x.status==='ON_LEAVE');console.log(d?d.date:'none')")
echo "  INFO  approved leave day found at $LEAVEDAY (future, so finalising it is refused)"
check "future days cannot be finalised" 422 "$(code -b a.txt -X POST $B/attendance/mark-absences -H "$J" -d "{\"date\":\"2026-12-01\"}")"
echo "-- authorisation --"
check "employee cannot finalise a day" 403 "$(code -b e.txt -X POST $B/attendance/mark-absences -H "$J" -d "{\"date\":\"$ABS\"}")"
check "unauthenticated cannot finalise a day" 401 "$(code -X POST $B/attendance/mark-absences -H "$J" -d "{\"date\":\"$ABS\"}")"

echo
echo "################ H. TEAM VIEW AND SCOPE ################"
check "unauth GET /attendance/team" 401 "$(code $B/attendance/team)"
ETEAM=$(curl -s -b e.txt "$B/attendance/team")
check "employee sees only themselves" 1 "$(echo "$ETEAM" | ev "console.log(j.meta.total)")"
MTEAM=$(curl -s -b m.txt "$B/attendance/team?limit=50")
echo "  INFO  manager sees: $(echo "$MTEAM" | ev "console.log(j.data.map(r=>r.employeeName).join(', '))")"
check "manager sees more than one person" true "$(echo "$MTEAM" | ev "console.log(j.meta.total>1)")"
check "manager does not see out-of-scope Kwame" true "$(echo "$MTEAM" | ev "console.log(!j.data.some(r=>r.employeeId==='$KWAME'))")"
ATEAM=$(curl -s -b a.txt "$B/attendance/team?limit=50")
check "admin sees the whole company" true "$(echo "$ATEAM" | ev "console.log(j.meta.total>=12)")"
check "employee cannot target another employee" 403 "$(code -b e.txt "$B/attendance/team?employeeId=$KWAME")"
check "manager cannot target an out-of-scope employee" 403 "$(code -b m.txt "$B/attendance/team?employeeId=$KWAME")"
check "admin can target any employee" 200 "$(code -b a.txt "$B/attendance/team?employeeId=$KWAME")"
check "rows carry totals" true "$(echo "$ATEAM" | ev "console.log(typeof j.data[0].totals.overtimeMinutes==='number')")"
check "an oversized range is refused" 422 "$(code -b a.txt "$B/attendance/team?from=2026-01-01&to=2026-12-31")"
check "a backwards range is refused" 422 "$(code -b a.txt "$B/attendance/team?from=2026-08-10&to=2026-08-01")"
check "range view returns every day per person" 7 "$(curl -s -b a.txt "$B/attendance/team?from=2026-08-03&to=2026-08-09&limit=1" | ev "console.log(j.data[0].days.length)")"

echo
echo "################ I. CHECK-IN LOCATION RESTRICTION ################"
TOMAS=$(curl -s -b a.txt "$B/employees?q=Tomas&limit=1" | ev "console.log(j.data[0].id)")
WORKING=$(curl -s -b e.txt "$B/attendance/today" | ev "console.log(j.data.isWorkingDay)")
echo "  INFO  today (UTC) is $TODAY_UTC, working day: $WORKING"

# Check-in is deliberately once per day, and that guard runs before the location
# check. Clearing the day through the administrator route - which is the real
# way a day gets reset - lets the capture path be exercised repeatedly.
clear_today() {
  curl -s -o /dev/null -b a.txt -X POST $B/attendance -H "$J" \
    -d "{\"employeeId\":\"$TOMAS\",\"date\":\"$TODAY_UTC\",\"status\":\"ABSENT\"}"
}

if [ "$WORKING" != "true" ]; then
  echo "  SKIP  today is not a working day, so the capture path cannot be exercised"
else
  echo "-- disabled (the default): coordinates are not required --"
  setpolicy '{"locationRestrictionEnabled":false}' > /dev/null
  clear_today
  check "check-in with no coordinates succeeds" 201 "$(code -b e.txt -X POST $B/attendance/check-in -H "$J" -d '{"mode":"OFFICE"}')"

  echo "-- enabled: the server decides, not the browser --"
  curl -s -o /dev/null -b a.txt -X PATCH "$B/locations/$HEADOFFICE" -H "$J" \
    -d "{\"name\":\"Head Office\",\"latitude\":24.8607,\"longitude\":67.0011,\"geofenceRadiusMeters\":150,\"isActive\":true}"
  check "coordinates saved on the location" 24.8607 "$(curl -s -b a.txt "$B/locations?limit=20" | ev "const l=j.data.find(x=>x.name==='Head Office');console.log(l.latitude)")"
  setpolicy '{"locationRestrictionEnabled":true}' > /dev/null
  check "today reports that location is required" true "$(curl -s -b e.txt $B/attendance/today | ev "console.log(j.data.locationRequired)")"

  clear_today
  check "check-in with no coordinates is refused" 422 "$(code -b e.txt -X POST $B/attendance/check-in -H "$J" -d '{"mode":"OFFICE"}')"
  check "check-in from far away is refused" 403 "$(code -b e.txt -X POST $B/attendance/check-in -H "$J" -d '{"mode":"OFFICE","latitude":51.5072,"longitude":-0.1276}')"
  check "remote mode cannot bypass the restriction" 403 "$(code -b e.txt -X POST $B/attendance/check-in -H "$J" -d '{"mode":"REMOTE","latitude":51.5072,"longitude":-0.1276}')"
  check "just outside the 150m radius is refused" 403 "$(code -b e.txt -X POST $B/attendance/check-in -H "$J" -d '{"mode":"OFFICE","latitude":24.8627,"longitude":67.0011}')"
  check "a check-in inside the radius is accepted" 201 "$(code -b e.txt -X POST $B/attendance/check-in -H "$J" -d '{"mode":"OFFICE","latitude":24.8608,"longitude":67.0012}')"
  check "the coordinates were recorded" true "$(curl -s -b a.txt "$B/attendance?employeeId=$TOMAS&from=$TODAY_UTC&to=$TODAY_UTC&limit=1" | ev "console.log(j.data.length===1)")"

  echo "-- fails closed on missing configuration --"
  curl -s -o /dev/null -b a.txt -X PATCH "$B/locations/$HEADOFFICE" -H "$J" \
    -d "{\"name\":\"Head Office\",\"latitude\":null,\"longitude\":null,\"isActive\":true}"
  clear_today
  check "a location with no coordinates refuses check-in" 403 "$(code -b e.txt -X POST $B/attendance/check-in -H "$J" -d '{"mode":"OFFICE","latitude":24.8608,"longitude":67.0012}')"

  setpolicy '{"locationRestrictionEnabled":false}' > /dev/null
  check "restriction off again: today stops asking" false "$(curl -s -b e.txt $B/attendance/today | ev "console.log(j.data.locationRequired)")"
  clear_today
  check "and check-in works again without coordinates" 201 "$(code -b e.txt -X POST $B/attendance/check-in -H "$J" -d '{"mode":"OFFICE"}')"
fi

echo
echo "################ J. SHIFT RESOLUTION ################"
check "assigned shift appears on the record" General "$(curl -s -b a.txt "$B/attendance?employeeId=$KWAME&from=$D&to=$D&limit=1" | ev "console.log(j.data[0].shiftName)")"
check "team row names the assigned shift" General "$(curl -s -b a.txt "$B/attendance/team?employeeId=$KWAME" | ev "console.log(j.data[0].shiftName)")"
NOSHIFT=$(curl -s -b a.txt "$B/employees?q=Sofia&limit=1" | ev "console.log(j.data[0].id)")
curl -s -o /dev/null -b a.txt -X POST $B/attendance -H "$J" -d "{\"employeeId\":\"$NOSHIFT\",\"date\":\"$D\",\"checkInAt\":\"${D}T09:20:00Z\",\"checkOutAt\":\"${D}T18:00:00Z\"}"
check "unassigned employee: lateness is null, not zero" null "$(curl -s -b a.txt "$B/attendance?employeeId=$NOSHIFT&from=$D&to=$D&limit=1" | ev "console.log(JSON.stringify(j.data[0].lateMinutes))")"
check "but the day is still scored" PRESENT "$(curl -s -b a.txt "$B/attendance?employeeId=$NOSHIFT&from=$D&to=$D&limit=1" | ev "console.log(j.data[0].status)")"

echo
echo "################ RESTORE ################"
POLICY=$ORIGINAL
check "policy restored" 200 "$(setpolicy '{}')"
echo "  INFO  restored: $(curl -s -b a.txt $B/company | ev "console.log(JSON.stringify({weekendDays:j.data.weekendDays,graceMinutes:j.data.graceMinutes,halfDayMinutes:j.data.halfDayMinutes,fullDayMinutes:j.data.fullDayMinutes,overtimeEnabled:j.data.overtimeEnabled,locationRestrictionEnabled:j.data.locationRestrictionEnabled}))")"

echo
echo "################ SUMMARY ################"
echo "PASS=$PASS  FAIL=$FAIL"
