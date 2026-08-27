#!/usr/bin/env bash
# Phase 4 verification: leave types, balances, requests, approvals, holidays.
# One login per account to stay under the login rate limit.
set -u

B=http://localhost:5173/api/v1
J='Content-Type: application/json'
DIR=$(mktemp -d); cd "$DIR" || exit 1
PASS=0; FAIL=0

ev() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);$1}catch(e){console.log('PARSE-FAIL:'+d.slice(0,140))}})"; }
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; PASS=$((PASS+1)); else echo "  FAIL  $1 — expected $2, got $3"; FAIL=$((FAIL+1)); fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "################ LOGINS ################"
for pair in "a.txt:admin@hrms.local:Admin@12345" "m.txt:manager@hrms.local:Manager@12345" "e.txt:employee@hrms.local:Employee@12345"; do
  jar=${pair%%:*}; rest=${pair#*:}; em=${rest%%:*}; pw=${rest#*:}
  check "login $em" 200 "$(curl -s -c "$jar" -X POST $B/auth/login -H "$J" -d "{\"email\":\"$em\",\"password\":\"$pw\"}" -o /dev/null -w '%{http_code}')"
done

echo
echo "################ A. LEAVE TYPE CRUD ################"
check "list leave types" 200 "$(code -b a.txt "$B/leave-types")"
SEEDED=$(curl -s -b a.txt "$B/leave-types?limit=50" | ev "console.log(j.meta.total)")
echo "  INFO  seeded leave types: $SEEDED"
NEWID=$(curl -s -b a.txt -X POST $B/leave-types -H "$J" -d '{"name":"Audit Leave","code":"AUD","annualEntitlementDays":12,"monthlyAccrualDays":1,"carryForwardEnabled":true,"carryForwardCapDays":3,"isPaid":true,"isActive":true}' | ev "console.log(j.data?j.data.id:'')")
check "create leave type" true "$([ -n "$NEWID" ] && echo true || echo false)"
check "update leave type" 200 "$(code -b a.txt -X PATCH "$B/leave-types/$NEWID" -H "$J" -d '{"name":"Audit Leave","code":"AUD","annualEntitlementDays":15,"monthlyAccrualDays":1.25,"carryForwardEnabled":true,"carryForwardCapDays":3,"isPaid":true,"isActive":true}')"
check "monthly accrual above annual rejected" 422 "$(code -b a.txt -X POST $B/leave-types -H "$J" -d '{"name":"Bad Policy","annualEntitlementDays":5,"monthlyAccrualDays":10}')"
check "delete unused leave type" 200 "$(code -b a.txt -X DELETE "$B/leave-types/$NEWID")"
check "employee cannot create leave type" 403 "$(code -b e.txt -X POST $B/leave-types -H "$J" -d '{"name":"Rogue","annualEntitlementDays":5,"monthlyAccrualDays":1}')"

echo
echo "################ B. BALANCES ################"
check "own balances" 200 "$(code -b e.txt "$B/leave/balances/me")"
ANNUAL=$(curl -s -b e.txt "$B/leave/balances/me" | ev "const b=j.data.find(x=>x.leaveTypeName==='Annual Leave');console.log(b?b.availableDays:'none')")
ACCRUED=$(curl -s -b e.txt "$B/leave/balances/me" | ev "const b=j.data.find(x=>x.leaveTypeName==='Annual Leave');console.log(b?b.accruedDays:'none')")
ENT=$(curl -s -b e.txt "$B/leave/balances/me" | ev "const b=j.data.find(x=>x.leaveTypeName==='Annual Leave');console.log(b?b.annualEntitlementDays:'none')")
echo "  INFO  Annual Leave: entitlement=$ENT accrued=$ACCRUED available=$ANNUAL"
check "accrual capped at entitlement" true "$(node -e "console.log($ACCRUED <= $ENT)")"
check "employee cannot adjust balances" 403 "$(code -b e.txt -X POST $B/leave/balances/adjust -H "$J" -d '{"employeeId":"x","leaveTypeId":"y","year":2026,"adjustmentDays":5}')"

echo
echo "################ C. LEAVE REQUEST VALIDATION ################"
AL=$(curl -s -b e.txt "$B/leave-types?limit=50" | ev "const t=j.data.find(x=>x.name==='Annual Leave');console.log(t.id)")
check "end before start rejected" 422 "$(code -b e.txt -X POST $B/leave/requests -H "$J" -d "{\"leaveTypeId\":\"$AL\",\"startDate\":\"2026-09-20\",\"endDate\":\"2026-09-10\",\"reason\":\"bad range\"}")"
check "half day over a range rejected" 422 "$(code -b e.txt -X POST $B/leave/requests -H "$J" -d "{\"leaveTypeId\":\"$AL\",\"startDate\":\"2026-09-10\",\"endDate\":\"2026-09-11\",\"dayPart\":\"FIRST_HALF\",\"reason\":\"bad half\"}")"
check "weekend-only range rejected" 422 "$(code -b e.txt -X POST $B/leave/requests -H "$J" -d "{\"leaveTypeId\":\"$AL\",\"startDate\":\"2026-09-05\",\"endDate\":\"2026-09-06\",\"reason\":\"weekend only\"}")"
check "exceeding balance rejected" 422 "$(code -b e.txt -X POST $B/leave/requests -H "$J" -d "{\"leaveTypeId\":\"$AL\",\"startDate\":\"2026-09-07\",\"endDate\":\"2026-12-31\",\"reason\":\"far too much\"}")"

echo "-- working-day counting (Mon 7 Sep to Fri 11 Sep 2026 = 5 days) --"
REQ=$(curl -s -b e.txt -X POST $B/leave/requests -H "$J" -d "{\"leaveTypeId\":\"$AL\",\"startDate\":\"2026-09-07\",\"endDate\":\"2026-09-11\",\"reason\":\"Audit: full week.\"}")
DAYS=$(echo "$REQ" | ev "console.log(j.data?j.data.totalDays:'ERR')")
check "5 working days counted" 5 "$DAYS"
LID=$(echo "$REQ" | ev "console.log(j.data?j.data.id:'')")
APID=$(echo "$REQ" | ev "console.log(j.data?j.data.approvalRequestId:'')")

check "overlapping request rejected" 422 "$(code -b e.txt -X POST $B/leave/requests -H "$J" -d "{\"leaveTypeId\":\"$AL\",\"startDate\":\"2026-09-09\",\"endDate\":\"2026-09-14\",\"reason\":\"overlap\"}")"

echo "-- pending leave is reserved against the balance --"
PEND=$(curl -s -b e.txt "$B/leave/balances/me" | ev "const b=j.data.find(x=>x.leaveTypeName==='Annual Leave');console.log(b.pendingDays)")
check "pending shows 5 days" 5 "$PEND"
AVAIL2=$(curl -s -b e.txt "$B/leave/balances/me" | ev "const b=j.data.find(x=>x.leaveTypeName==='Annual Leave');console.log(b.availableDays)")
check "available reduced by pending" true "$(node -e "console.log($AVAIL2 === $ANNUAL - 5)")"

echo
echo "################ D. APPROVAL VIA THE PHASE 3 ENGINE ################"
check "appears in manager inbox" true "$(curl -s -b m.txt "$B/approvals?view=inbox&limit=50" | ev "console.log(j.data.some(a=>a.id==='$APID'&&a.subjectType==='LEAVE_REQUEST'))")"
check "employee cannot approve own leave" 403 "$(code -b e.txt -X POST "$B/approvals/$APID/approve" -H "$J" -d '{}')"
check "manager approves" 200 "$(code -b m.txt -X POST "$B/approvals/$APID/approve" -H "$J" -d '{"comment":"Enjoy."}')"
check "leave mirrored to APPROVED" APPROVED "$(curl -s -b e.txt "$B/leave/requests/$LID" | ev "console.log(j.data.status)")"
check "terminal: re-approve rejected" 409 "$(code -b m.txt -X POST "$B/approvals/$APID/approve" -H "$J" -d '{}')"

USED=$(curl -s -b e.txt "$B/leave/balances/me" | ev "const b=j.data.find(x=>x.leaveTypeName==='Annual Leave');console.log(b.usedDays)")
PEND2=$(curl -s -b e.txt "$B/leave/balances/me" | ev "const b=j.data.find(x=>x.leaveTypeName==='Annual Leave');console.log(b.pendingDays)")
check "used becomes 5 after approval" 5 "$USED"
check "pending returns to 0" 0 "$PEND2"
check "employee notified of decision" true "$(curl -s -b e.txt "$B/notifications?limit=10" | ev "console.log(j.data.some(n=>n.type==='APPROVAL_APPROVED'))")"

echo
echo "################ E. REJECTION AND CANCELLATION ################"
R2=$(curl -s -b e.txt -X POST $B/leave/requests -H "$J" -d "{\"leaveTypeId\":\"$AL\",\"startDate\":\"2026-10-05\",\"endDate\":\"2026-10-06\",\"reason\":\"Audit: to reject.\"}")
AP2=$(echo "$R2" | ev "console.log(j.data?j.data.approvalRequestId:'')")
L2=$(echo "$R2" | ev "console.log(j.data?j.data.id:'')")
check "manager rejects" 200 "$(code -b m.txt -X POST "$B/approvals/$AP2/reject" -H "$J" -d '{"comment":"Coverage."}')"
check "leave mirrored to REJECTED" REJECTED "$(curl -s -b e.txt "$B/leave/requests/$L2" | ev "console.log(j.data.status)")"
check "rejected days not counted as used" 5 "$(curl -s -b e.txt "$B/leave/balances/me" | ev "const b=j.data.find(x=>x.leaveTypeName==='Annual Leave');console.log(b.usedDays)")"

R3=$(curl -s -b e.txt -X POST $B/leave/requests -H "$J" -d "{\"leaveTypeId\":\"$AL\",\"startDate\":\"2026-11-02\",\"endDate\":\"2026-11-03\",\"reason\":\"Audit: to cancel.\"}")
L3=$(echo "$R3" | ev "console.log(j.data?j.data.id:'')")
check "employee cancels own leave" 200 "$(code -b e.txt -X POST "$B/leave/requests/$L3/cancel" -H "$J" -d '{"reason":"Plans changed."}')"
check "leave mirrored to CANCELLED" CANCELLED "$(curl -s -b e.txt "$B/leave/requests/$L3" | ev "console.log(j.data.status)")"
check "cancelled days released" 5 "$(curl -s -b e.txt "$B/leave/balances/me" | ev "const b=j.data.find(x=>x.leaveTypeName==='Annual Leave');console.log(b.usedDays)")"

echo
echo "################ F. HOLIDAYS ################"
check "list holidays" 200 "$(code -b a.txt "$B/holidays")"
HOL=$(curl -s -b a.txt -X POST $B/holidays -H "$J" -d '{"name":"Audit Holiday","date":"2026-09-16","isActive":true}' | ev "console.log(j.data?j.data.id:'')")
check "create company-wide holiday" true "$([ -n "$HOL" ] && echo true || echo false)"
check "duplicate company-wide date rejected" 409 "$(code -b a.txt -X POST $B/holidays -H "$J" -d '{"name":"Clash","date":"2026-09-16","isActive":true}')"
LOC=$(curl -s -b a.txt "$B/locations?limit=5" | ev "console.log(j.data[0].id)")
check "same date for a location is allowed" 201 "$(code -b a.txt -X POST $B/holidays -H "$J" -d "{\"name\":\"Local Day\",\"date\":\"2026-09-16\",\"locationId\":\"$LOC\",\"isActive\":true}")"
check "employee cannot create holiday" 403 "$(code -b e.txt -X POST $B/holidays -H "$J" -d '{"name":"Rogue","date":"2026-09-17"}')"

echo "-- a holiday reduces the working days counted --"
R4=$(curl -s -b e.txt -X POST $B/leave/requests -H "$J" -d "{\"leaveTypeId\":\"$AL\",\"startDate\":\"2026-09-14\",\"endDate\":\"2026-09-18\",\"reason\":\"Audit: week containing a holiday.\"}")
D4=$(echo "$R4" | ev "console.log(j.data?j.data.totalDays:'ERR')")
check "5-day week with 1 holiday = 4 days" 4 "$D4"
L4=$(echo "$R4" | ev "console.log(j.data?j.data.id:'')")
curl -s -b e.txt -X POST "$B/leave/requests/$L4/cancel" -H "$J" -d '{}' -o /dev/null

echo "-- employees see only holidays that apply to them --"
EMPHOL=$(curl -s -b e.txt "$B/holidays?year=2026&limit=100" | ev "console.log(j.meta.total)")
ADMHOL=$(curl -s -b a.txt "$B/holidays?year=2026&limit=100" | ev "console.log(j.meta.total)")
echo "  INFO  employee sees $EMPHOL, admin sees $ADMHOL"
check "employee sees no more than admin" true "$(node -e "console.log($EMPHOL <= $ADMHOL)")"

echo
echo "################ G. SECURITY ################"
for p in leave-types "leave/requests" "leave/balances/me" holidays; do
  check "unauth GET /$p" 401 "$(code $B/$p)"
done
KID=$(curl -s -b a.txt "$B/employees?q=Kwame&limit=1" | ev "console.log(j.data[0].id)")
check "employee -> out-of-scope balances" 403 "$(code -b e.txt "$B/leave/balances/employee/$KID")"
check "manager -> out-of-scope balances" 403 "$(code -b m.txt "$B/leave/balances/employee/$KID")"
check "admin -> any balances" 200 "$(code -b a.txt "$B/leave/balances/employee/$KID")"
EMPSEES=$(curl -s -b e.txt "$B/leave/requests?limit=50" | ev "console.log(j.meta.total)")
ADMSEES=$(curl -s -b a.txt "$B/leave/requests?limit=50" | ev "console.log(j.meta.total)")
echo "  INFO  leave visible: employee=$EMPSEES admin=$ADMSEES"
check "employee sees no more leave than admin" true "$(node -e "console.log($EMPSEES <= $ADMSEES)")"

echo
echo "################ SUMMARY ################"
echo "PASS=$PASS  FAIL=$FAIL"
