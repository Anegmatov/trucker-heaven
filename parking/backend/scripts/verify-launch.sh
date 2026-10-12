#!/usr/bin/env bash
set -euo pipefail

container="parkingops-verify-$$"
test_database="parkingops_test"
test_user="postgres"
test_schema="public"
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD DATABASE_URL

printf 'Resolved disposable DB container target: host=%s port=%s database=%s user=%s schema=%s\n' \
  "$container" "5432" "$test_database" "$test_user" "$test_schema"
test "$test_database" != "ifta_db"

cleanup() { docker stop "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --rm -d --name "$container" \
  -e POSTGRES_PASSWORD=parkingops_test \
  -e POSTGRES_DB="$test_database" \
  -p 127.0.0.1::5432 postgres:18 >/dev/null

for _ in $(seq 1 30); do
  if docker exec "$container" pg_isready -U "$test_user" -d "$test_database" >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container" pg_isready -U "$test_user" -d "$test_database" >/dev/null
port="$(docker port "$container" 5432/tcp | sed -E 's/.*:([0-9]+)$/\1/')"
test_url="postgres://postgres:parkingops_test@127.0.0.1:${port}/${test_database}"

printf 'Resolved DB target before migrations pass 1: host=127.0.0.1 port=%s database=%s user=%s schema=%s\n' "$port" "$test_database" "$test_user" "$test_schema"
DATABASE_URL="$test_url" npm run migrate
printf 'Resolved DB target before migrations pass 2: host=127.0.0.1 port=%s database=%s user=%s schema=%s\n' "$port" "$test_database" "$test_user" "$test_schema"
DATABASE_URL="$test_url" npm run migrate
printf 'Resolved DB target before seed: host=127.0.0.1 port=%s database=%s user=%s schema=%s\n' "$port" "$test_database" "$test_user" "$test_schema"
DATABASE_URL="$test_url" npm run seed
printf 'Resolved DB target before complete ParkingOps suite: host=127.0.0.1 port=%s database=%s user=%s schema=%s\n' "$port" "$test_database" "$test_user" "$test_schema"
PARKING_TEST_DATABASE="$test_database" DATABASE_URL="$test_url" npm run verify:launch
PARKING_TEST_DATABASE="$test_database" DATABASE_URL="$test_url" npm run test:lifecycle
PARKING_TEST_DATABASE="$test_database" DATABASE_URL="$test_url" npm run verify:cross-frontend

(cd ../frontend-admin && npm run verify:all && npm run verify:browser)
(cd ../frontend-customer && npm run check && npm test && npm run verify:responsive && npm run verify:map && npm run verify:flow && npm run verify:security-headers && npm run build && npm run verify:build)
git -C .. diff --check

if [ "${PARKING_VERIFY_PARENT_SITE:-true}" = "true" ]; then
  parent_dir="${PARKING_PARENT_SITE_DIR:-/mnt/d/hp/Documents/trucker-heaven-v3/trucker-heaven-frontend-v3}"
  node "$parent_dir/scripts/verify-site.js"
else
  printf 'Parent-site verification skipped because PARKING_VERIFY_PARENT_SITE=false.\n'
fi
