#!/usr/bin/env bash
# Phase 5 verification: attendance capture, derivation and approval write-through.
set -u

B=http://localhost:5173/api/v1
J='Content-Type: application/json'
DIR=$(mktemp -d); cd "$DIR" || exit 1
PASS=0; FAIL=0

ev() { node -e "let _buf='';process.stdin.on('data',c=>_buf+=c).on('end',()=>{try{const j=JSON.parse(_buf);$1}catch(e){console.log('ERR:'+e.message)}})"; }
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; PASS=$((PASS+1)); else echo "  FAIL  $1 — expected $2, got $3"; FAIL=$((FAIL+1)); fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "################ LOGINS ################"
for pair in "a.txt:admin@hrms.local:Admin@12345" "m.txt:manager@hrms.local:Manager@12345" "e.txt:employee@hrms.local:Employee@12345"; do
  jar=${pair%%:*}; rest=${pair#*:}; em=${rest%%:*}; pw=${rest#*:}
  check "login $em" 200 "$(curl -s -c "$jar" -X POST $B/auth/login -H "$J" -d "{\"email\":\"$em\",\"password\":\"$pw\"}" -o /dev/null -w '%{http_code}')"
done

echo
echo "################ A. CHECK-IN / CHECK-OUT ################"
TODAY=$(curl -s -b e.txt "$B/attendance/today")
echo "  INFO  today: $(echo "$TODAY" | ev "console.log('status='+j.data.status+' workingDay='+j.data.isWorkingDay+' shift='+(j.data.shiftName||'none'))")"
WORKING=$(echo "$TODAY" | ev "console.log(j.data.isWorkingDay)")

if [ "$WORKING" = "true" ]; then
  check "check in" 201 "$(code -b e.txt -X POST $B/attendance/check-in -H "$J" -d '{"mode":"REMOTE"}')"
  check "duplicate check-in rejected" 409 "$(code -b e.txt -X POST $B/attendance/check-in -H "$J" -d '{"mode":"OFFICE"}')"
  check "checkedIn now true" true "$(curl -s -b e.txt "$B/attendance/today" | ev "console.log(j.data.checkedIn)")"
  check "check out" 200 "$(code -b e.txt -X POST $B/attendance/check-out -H "$J" -d '{}')"
  check "duplicate check-out rejected" 409 "$(code -b e.txt -X POST $B/attendance/check-out -H "$J" -d '{}')"
  check "status is PRESENT" PRESENT "$(curl -s -b e.txt "$B/attendance/today" | ev "console.log(j.data.status)")"
else
  echo "  SKIP  today is not a working day ($(echo "$TODAY" | ev "console.log(j.data.reason)"))"
  check "check-in refused on non-working day" 409 "$(code -b e.txt -X POST $B/attendance/check-in -H "$J" -d '{"mode":"OFFICE"}')"
fi
check "check-out without check-in rejected" 409 "$(code -b m.txt -X POST $B/attendance/check-out -H "$J" -d '{}')"

echo
echo "################ B. DAY DERIVATION ################"
SUM=$(curl -s -b e.txt "$B/attendance/summary?from=2026-09-01&to=2026-09-30")
check "summary returns every calendar day" 30 "$(echo "$SUM" | ev "console.log(j.data.days.length)")"
check "weekends derived" true "$(echo "$SUM" | ev "console.log(j.data.totals.weekend>0)")"
echo "  INFO  Sep totals: $(echo "$SUM" | ev "console.log('present='+j.data.totals.present+' absent='+j.data.totals.absent+' leave='+j.data.totals.onLeave+' holiday='+j.data.totals.holiday+' weekend='+j.data.totals.weekend)")"
echo "-- approved leave shows as ON_LEAVE without any attendance record --"
check "21 Sep is ON_LEAVE" ON_LEAVE "$(echo "$SUM" | ev "const d=j.data.days.find(x=>x.date==='2026-09-21');console.log(d?d.status:'missing')")"
check "and names the leave type" "Annual Leave" "$(echo "$SUM" | ev "const d=j.data.days.find(x=>x.date==='2026-09-21');console.log(d?d.leaveTypeName:'null')")"
check "with no stored record" false "$(echo "$SUM" | ev "const d=j.data.days.find(x=>x.date==='2026-09-21');console.log(d?d.hasRecord:'x')")"
echo "-- holidays derived from the location calendar --"
HOLDAY=$(echo "$SUM" | ev "const d=j.data.days.find(x=>x.status==='HOLIDAY');console.log(d?d.date+' '+d.holidayName:'none')")
echo "  INFO  holiday in Sep: $HOLDAY"

echo
echo "################ C. REGULARIZATION WRITE-THROUGH ################"
# Pick a past working day with no record.
TARGET=2026-08-19
check "raise correction" 201 "$(code -b e.txt -X POST $B/attendance/regularizations -H "$J" -d "{\"attendanceDate\":\"$TARGET\",\"requestedStatus\":\"PRESENT\",\"requestedCheckInAt\":\"${TARGET}T09:05:00Z\",\"requestedCheckOutAt\":\"${TARGET}T17:35:00Z\",\"reason\":\"Phase 5: write-through test.\"}")"
RID=$(curl -s -b m.txt "$B/approvals?view=inbox&limit=20" | ev "const r=j.data.find(a=>a.subjectType==='ATTENDANCE_REGULARIZATION');console.log(r?r.id:'')")
echo "  INFO  approval: $RID"
echo "  BEFORE: $(curl -s -b e.txt "$B/attendance/summary?from=$TARGET&to=$TARGET" | ev "const d=j.data.days[0];console.log('status='+d.status+' hasRecord='+d.hasRecord+' worked='+d.workedMinutes)")"
check "manager approves" 200 "$(code -b m.txt -X POST "$B/approvals/$RID/approve" -H "$J" -d '{"comment":"Confirmed."}')"
AFTER=$(curl -s -b e.txt "$B/attendance/summary?from=$TARGET&to=$TARGET")
echo "  AFTER:  $(echo "$AFTER" | ev "const d=j.data.days[0];console.log('status='+d.status+' hasRecord='+d.hasRecord+' worked='+d.workedMinutes)")"
check "record now exists" true "$(echo "$AFTER" | ev "console.log(j.data.days[0].hasRecord)")"
check "status written through" PRESENT "$(echo "$AFTER" | ev "console.log(j.data.days[0].status)")"
check "worked minutes computed (510)" 510 "$(echo "$AFTER" | ev "console.log(j.data.days[0].workedMinutes)")"

echo
echo "################ D. SHIFT-CHANGE WRITE-THROUGH ################"
BEFOREN=$(curl -s -b a.txt "$B/shifts/assignments?limit=100" | ev "console.log(j.meta.total)")
echo "  INFO  assignments before: $BEFOREN"
LATE=$(curl -s -b e.txt "$B/shifts?limit=10" | ev "const s=j.data.find(x=>x.name==='Late');console.log(s.id)")
check "raise shift change" 201 "$(code -b e.txt -X POST $B/shifts/change-requests -H "$J" -d "{\"requestedShiftId\":\"$LATE\",\"effectiveFrom\":\"2026-10-01\",\"reason\":\"Phase 5: write-through test.\"}")"
SID=$(curl -s -b m.txt "$B/approvals?view=inbox&limit=20" | ev "const r=j.data.find(a=>a.subjectType==='SHIFT_CHANGE');console.log(r?r.id:'')")
check "manager approves" 200 "$(code -b m.txt -X POST "$B/approvals/$SID/approve" -H "$J" -d '{}')"
AFTERN=$(curl -s -b a.txt "$B/shifts/assignments?limit=100" | ev "console.log(j.meta.total)")
echo "  INFO  assignments after: $AFTERN"
check "assignment created by approval" true "$(node -e "console.log($AFTERN === $BEFOREN + 1)")"
check "assignment is the requested shift" Late "$(curl -s -b a.txt "$B/shifts/assignments?limit=100" | ev "const a=j.data.find(x=>x.effectiveFrom==='2026-10-01');console.log(a?a.shiftName:'none')")"

echo
echo "################ E. WEEKEND CONFIGURATION IS DATA-DRIVEN ################"
check "company exposes weekendDays" 200 "$(code -b a.txt "$B/company")"
echo "  INFO  weekendDays: $(curl -s -b a.txt "$B/company" | ev "console.log((j.data.weekendDays||[]).join(','))")"

echo
echo "################ F. SECURITY ################"
for p in "attendance/today" "attendance/summary"; do
  check "unauth GET /$p" 401 "$(code $B/$p)"
done
check "unauth POST /attendance/check-in" 401 "$(code -X POST $B/attendance/check-in -H "$J" -d '{}')"
KID=$(curl -s -b a.txt "$B/employees?q=Kwame&limit=1" | ev "console.log(j.data[0].id)")
check "employee -> out-of-scope summary" 403 "$(code -b e.txt "$B/attendance/summary?employeeId=$KID")"
check "manager -> out-of-scope summary" 403 "$(code -b m.txt "$B/attendance/summary?employeeId=$KID")"
check "admin -> any summary" 200 "$(code -b a.txt "$B/attendance/summary?employeeId=$KID")"
check "employee cannot assign shifts" 403 "$(code -b e.txt -X POST $B/shifts/assignments -H "$J" -d "{\"employeeId\":\"$KID\",\"shiftId\":\"$LATE\",\"effectiveFrom\":\"2026-10-01\"}")"

echo
echo "################ SUMMARY ################"
echo "PASS=$PASS  FAIL=$FAIL"
