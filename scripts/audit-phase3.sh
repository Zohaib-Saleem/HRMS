#!/usr/bin/env bash
# Phase 3 production-readiness audit.
# One login per account (login is rate limited to 10 per 5 min per IP), then
# cookie jars are reused for every request.
set -u

B=http://localhost:5173/api/v1
J='Content-Type: application/json'
DIR=$(mktemp -d); cd "$DIR" || exit 1
PASS=0; FAIL=0

ev() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);$1}catch(e){console.log('PARSE-FAIL:'+d.slice(0,120))}})"; }

# check <label> <expected> <actual>
check() {
  if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; PASS=$((PASS+1));
  else echo "  FAIL  $1 — expected $2, got $3"; FAIL=$((FAIL+1)); fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "################ LOGINS ################"
for pair in "a.txt:admin@hrms.local:Admin@12345" "m.txt:manager@hrms.local:Manager@12345" "e.txt:employee@hrms.local:Employee@12345"; do
  jar=${pair%%:*}; rest=${pair#*:}; em=${rest%%:*}; pw=${rest#*:}
  c=$(curl -s -c "$jar" -X POST $B/auth/login -H "$J" -d "{\"email\":\"$em\",\"password\":\"$pw\"}" -o /dev/null -w '%{http_code}')
  check "login $em" 200 "$c"
done

echo
echo "################ 1. APPROVAL ENGINE ################"

echo "-- multi-level chain (2 steps: manager then admin) --"
c=$(code -b e.txt -X POST $B/attendance/regularizations -H "$J" -d '{"attendanceDate":"2026-07-01","reason":"Audit: multi-level chain."}')
check "raise request" 201 "$c"
MID=$(curl -s -b m.txt "$B/approvals?view=inbox&limit=1" | ev "console.log(j.data&&j.data[0]?j.data[0].id:'')")
STEPS=$(curl -s -b m.txt "$B/approvals/$MID" | ev "console.log(j.data.totalSteps)")
check "chain has 2 steps" 2 "$STEPS"

echo "-- step 1 approved by its assigned approver: stays PENDING, advances --"
S1=$(curl -s -b m.txt -X POST "$B/approvals/$MID/approve" -H "$J" -d '{"comment":"step 1 ok"}' | ev "console.log(j.data.status)")
check "still PENDING after step 1" PENDING "$S1"
CUR=$(curl -s -b m.txt "$B/approvals/$MID" | ev "console.log(j.data.currentStep)")
check "advanced to step 2" 2 "$CUR"

echo "-- separation of duties: the step-1 decider cannot also decide step 2 --"
c=$(code -b m.txt -X POST "$B/approvals/$MID/approve" -H "$J" -d '{}')
check "manager blocked at step 2" 403 "$c"

echo "-- step 2 approved by its approver: request completes --"
S2=$(curl -s -b a.txt -X POST "$B/approvals/$MID/approve" -H "$J" -d '{"comment":"step 2 ok"}' | ev "console.log(j.data.status)")
check "APPROVED after final step" APPROVED "$S2"

echo "-- terminal state is immutable --"
check "re-approve" 409 "$(code -b a.txt -X POST "$B/approvals/$MID/approve" -H "$J" -d '{}')"
check "reject after approve" 409 "$(code -b a.txt -X POST "$B/approvals/$MID/reject" -H "$J" -d '{}')"
check "cancel after approve" 409 "$(code -b e.txt -X POST "$B/approvals/$MID/cancel" -H "$J" -d '{}')"

echo "-- history persisted for every transition --"
EV=$(curl -s -b a.txt "$B/approvals/$MID" | ev "console.log(j.data.events.length)")
check "3 events (submit + 2 approvals)" 3 "$EV"

echo "-- domain record mirrored --"
MIR=$(curl -s -b e.txt "$B/attendance/regularizations?limit=50" | ev "const r=j.data.find(x=>x.attendanceDate==='2026-07-01');console.log(r?r.status:'missing')")
check "regularization mirrored to APPROVED" APPROVED "$MIR"

echo "-- administrative override is allowed, marked as such, and NOT chainable --"
c=$(code -b e.txt -X POST $B/attendance/regularizations -H "$J" -d '{"attendanceDate":"2026-07-03","reason":"Audit: override path."}')
check "raise second 2-step request" 201 "$c"
OID=$(curl -s -b a.txt "$B/approvals?view=all&status=PENDING&limit=50" | ev "const r=j.data.find(x=>x.title.indexOf('2026-07-03')>-1);console.log(r?r.id:'')")
OV=$(curl -s -b a.txt -X POST "$B/approvals/$OID/approve" -H "$J" -d '{"comment":"approver unavailable"}' | ev "console.log(j.data?j.data.status:'ERR')")
check "admin overrides step 1 (assigned to manager)" PENDING "$OV"
ACT=$(curl -s -b a.txt "$B/approvals/$OID" | ev "console.log(j.data.events.some(e=>e.action.endsWith('.override')))")
check "override recorded in history" true "$ACT"
check "same admin cannot then decide step 2" 403 "$(code -b a.txt -X POST "$B/approvals/$OID/approve" -H "$J" -d '{}')"

echo "-- self-approval blocked for a user holding approval.act --"
SID=$(curl -s -b a.txt "$B/shifts?limit=5" | ev "console.log(j.data[0].id)")
OWN=$(curl -s -b a.txt -X POST $B/shifts/change-requests -H "$J" -d "{\"requestedShiftId\":\"$SID\",\"effectiveFrom\":\"2026-10-01\",\"reason\":\"Audit self-approval.\"}" | ev "console.log(j.data?j.data.approvalRequestId:'')")
if [ -n "$OWN" ]; then check "admin approving own request" 403 "$(code -b a.txt -X POST "$B/approvals/$OWN/approve" -H "$J" -d '{}')"; else echo "  SKIP  admin already has a pending shift request"; fi

echo
echo "################ 2. NOTIFICATIONS ################"
UC=$(curl -s -b m.txt "$B/notifications/unread-count" | ev "console.log(j.data.count>=0)")
check "unread-count returns a number" true "$UC"
NID=$(curl -s -b m.txt "$B/notifications?limit=1" | ev "console.log(j.data[0]?j.data[0].id:'')")
check "mark one read" 200 "$(code -b m.txt -X POST "$B/notifications/$NID/read")"
check "mark all read" 200 "$(code -b m.txt -X POST $B/notifications/read-all)"
AFTER=$(curl -s -b m.txt "$B/notifications/unread-count" | ev "console.log(j.data.count)")
check "unread is 0 after mark-all" 0 "$AFTER"
echo "-- IDOR: employee tries to read the manager's notification --"
check "cross-user mark-read" 404 "$(code -b e.txt -X POST "$B/notifications/$NID/read")"
OWNER=$(curl -s -b e.txt "$B/notifications?limit=50" | ev "console.log(j.data.some(n=>n.id==='$NID'))")
check "manager notification absent from employee list" false "$OWNER"

echo
echo "################ 3. TIMESHEETS ################"
echo "-- per-entry minute validation --"
check "entry >1440 minutes rejected" 422 "$(code -b e.txt -X POST $B/timesheets -H "$J" -d '{"periodStart":"2026-06-01","periodEnd":"2026-06-07","entries":[{"date":"2026-06-01","minutes":2400}]}')"
check "40h spread across days accepted" 201 "$(code -b e.txt -X POST $B/timesheets -H "$J" -d '{"periodStart":"2026-06-01","periodEnd":"2026-06-07","entries":[{"date":"2026-06-01","minutes":480},{"date":"2026-06-02","minutes":480},{"date":"2026-06-03","minutes":480},{"date":"2026-06-04","minutes":480},{"date":"2026-06-05","minutes":480}]}')"
check "duplicate period rejected" 409 "$(code -b e.txt -X POST $B/timesheets -H "$J" -d '{"periodStart":"2026-06-01","periodEnd":"2026-06-07","entries":[]}')"
check "periodEnd before start rejected" 422 "$(code -b e.txt -X POST $B/timesheets -H "$J" -d '{"periodStart":"2026-06-20","periodEnd":"2026-06-10","entries":[]}')"
TSID=$(curl -s -b e.txt "$B/timesheets?limit=50" | ev "const t=j.data.find(x=>x.periodStart==='2026-06-01');console.log(t?t.id:'')")
check "submit draft" 200 "$(code -b e.txt -X POST "$B/timesheets/$TSID/submit")"
check "duplicate submit rejected" 409 "$(code -b e.txt -X POST "$B/timesheets/$TSID/submit")"
echo "-- no mutation endpoint exists for an approved/submitted sheet --"
check "PATCH timesheet not routed" 404 "$(code -b e.txt -X PATCH "$B/timesheets/$TSID" -H "$J" -d '{}')"
check "DELETE timesheet not routed" 404 "$(code -b e.txt -X DELETE "$B/timesheets/$TSID")"

echo
echo "################ 4. SECURITY / IDOR ################"
echo "-- unauthenticated --"
for p in approvals notifications timesheets attendance shifts employees departments; do
  check "unauth GET /$p" 401 "$(code $B/$p)"
done
echo "-- IDOR: employee reading an out-of-scope employee record --"
KID=$(curl -s -b a.txt "$B/employees?q=Kwame&limit=1" | ev "console.log(j.data[0].id)")
check "employee -> out-of-scope employee" 403 "$(code -b e.txt "$B/employees/$KID")"
check "manager -> out-of-scope employee" 403 "$(code -b m.txt "$B/employees/$KID")"
echo "-- IDOR: employee reading an approval they are not party to --"
ADMOWN=$(curl -s -b a.txt "$B/approvals?view=mine&limit=1" | ev "console.log(j.data&&j.data[0]?j.data[0].id:'')")
if [ -n "$ADMOWN" ]; then check "employee -> admin's approval" 403 "$(code -b e.txt "$B/approvals/$ADMOWN")"; else echo "  SKIP  admin has no own approval"; fi
echo "-- IDOR: employee reading another employee's timesheet --"
ATS=$(curl -s -b a.txt "$B/timesheets?limit=50" | ev "const t=j.data.find(x=>x.employeeName.indexOf('Tomas')===-1);console.log(t?t.id:'')")
if [ -n "$ATS" ]; then check "employee -> other timesheet" 403 "$(code -b e.txt "$B/timesheets/$ATS")"; else echo "  SKIP  no other timesheet exists"; fi
echo "-- privilege: employee without approval.act --"
PEND=$(curl -s -b m.txt "$B/approvals?view=inbox&limit=1" | ev "console.log(j.data&&j.data[0]?j.data[0].id:'')")
if [ -n "$PEND" ]; then check "employee decide attempt" 403 "$(code -b e.txt -X POST "$B/approvals/$PEND/approve" -H "$J" -d '{}')"; else echo "  SKIP  no pending request"; fi
echo "-- privilege: employee cannot manage org data --"
check "employee create department" 403 "$(code -b e.txt -X POST $B/departments -H "$J" -d '{"name":"Rogue Dept","isActive":true}')"
check "employee create shift" 403 "$(code -b e.txt -X POST $B/shifts -H "$J" -d '{"name":"Rogue","startTime":"09:00","endTime":"17:00"}')"
check "employee record attendance for others" 403 "$(code -b e.txt -X POST $B/attendance -H "$J" -d "{\"employeeId\":\"$KID\",\"date\":\"2026-07-02\",\"status\":\"PRESENT\"}")"
echo "-- restricted fields (Phase 2 regression) --"
SELF=$(curl -s -b m.txt "$B/employees?q=Amara&limit=1" | ev "console.log(j.data[0].id)")
check "manager sees restricted block" false "$(curl -s -b m.txt "$B/employees/$SELF" | ev "console.log('restricted' in j.data)")"
check "admin sees restricted block" true "$(curl -s -b a.txt "$B/employees/$SELF" | ev "console.log('restricted' in j.data)")"

echo
echo "################ 5. SEARCH / FILTERING ################"
check "attendance filter by status" 200 "$(code -b a.txt "$B/attendance?status=PRESENT")"
check "timesheet filter by status" 200 "$(code -b a.txt "$B/timesheets?status=SUBMITTED")"
QA=$(curl -s -b a.txt "$B/attendance?q=zzzznomatch&limit=50" | ev "console.log(j.meta.total)")
QA_ALL=$(curl -s -b a.txt "$B/attendance?limit=50" | ev "console.log(j.meta.total)")
echo "  INFO  attendance q=nomatch -> $QA rows, unfiltered -> $QA_ALL rows"
QT=$(curl -s -b a.txt "$B/timesheets?q=zzzznomatch&limit=50" | ev "console.log(j.meta.total)")
QT_ALL=$(curl -s -b a.txt "$B/timesheets?limit=50" | ev "console.log(j.meta.total)")
echo "  INFO  timesheets q=nomatch -> $QT rows, unfiltered -> $QT_ALL rows"

echo
echo "################ 6. SHIFTS ################"
check "list shifts" 200 "$(code -b a.txt "$B/shifts")"
check "list assignments" 200 "$(code -b a.txt "$B/shifts/assignments")"
check "list change-requests" 200 "$(code -b a.txt "$B/shifts/change-requests")"
check "employee cannot assign shifts" 403 "$(code -b e.txt -X POST $B/shifts/assignments -H "$J" -d '{"employeeId":"x","shiftId":"y","effectiveFrom":"2026-01-01"}')"

echo
echo "################ 7. PASSWORD RESET ################"
R1=$(curl -s -X POST $B/auth/forgot-password -H "$J" -d '{"email":"employee@hrms.local"}')
R2=$(curl -s -X POST $B/auth/forgot-password -H "$J" -d '{"email":"does-not-exist@nowhere.example"}')
check "identical response known vs unknown" "$R1" "$R2"
check "bogus token rejected" 422 "$(code -X POST $B/auth/reset-password -H "$J" -d '{"token":"bogus-token-1234567890","newPassword":"Abcdef12345","confirmPassword":"Abcdef12345"}')"

echo
echo "################ SUMMARY ################"
echo "PASS=$PASS  FAIL=$FAIL"
