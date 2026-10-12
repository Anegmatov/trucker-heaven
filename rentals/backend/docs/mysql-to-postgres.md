# Moving existing MySQL data to PostgreSQL

This is a one-time data move; it is deliberately separate from the production backend. The production application contains only the PostgreSQL `pg` driver and never connects to a MySQL database.

## Safety rules

- Take a verified MySQL backup before doing anything.
- Run the export with a read-only MySQL account where possible.
- Do not run `DROP`, `TRUNCATE`, or schema-reset commands against either production database.
- Rehearse the procedure on a copy of the data first.
- Keep the applications stopped or in read-only mode for the final cutover so new writes are not lost.

## 1. Initialize the target

Create the PostgreSQL role and database, set `DATABASE_URL` or the `PG*` variables, then run:

```bash
cd backend
npm install
npm run migrate
```

The migrations create lower-case PostgreSQL columns. Preserve the listed IDs when importing so existing references continue to work:

| Source table | PostgreSQL table | ID column |
| --- | --- | --- |
| `Vehicles` | `vehicles` | `vehicleid` |
| `VehiclePhotos` | `vehiclephotos` | `photoid` |
| `ReservationsMVP` | `reservationsmvp` | `reservationid` |
| `Customers` | `customers` | `custid` |
| `Cars` | `cars` | `carid` |
| `Rental` | `rental` | `rentid` |
| `PaymentDetails` | `paymentdetails` | `paymentid` |

Convert `TINYINT(1)` photo flags to `true`/`false`, and convert event dates to ISO-8601 timestamps with an explicit offset. Monetary values must retain their decimal text representation so they import into `NUMERIC(10,2)` without a floating-point conversion.

## 2. Export and load in foreign-key order

Use a vetted ETL tool such as pgloader, or export each MySQL table as CSV without headers and load it with PostgreSQL `\copy`. Import in this order:

1. `vehicles`, `customers`, and `cars`
2. `vehiclephotos`
3. `reservationsmvp` and `rental`
4. `paymentdetails`

Map source mixed-case names to the lower-case target names listed above. Do not import the MySQL `RentalDetails` view; PostgreSQL migration `002_legacy_compatibility.sql` recreates the compatibility view.

For each table, compare source and target row counts and spot-check foreign keys before proceeding to the next table. Keep password hashes unchanged; never export or log plaintext passwords.

## 3. Reset identity sequences after preserving IDs

Run this against PostgreSQL after each ID-preserving import. The `setval` call makes the next generated ID greater than the largest imported one.

```sql
SELECT setval(pg_get_serial_sequence('vehicles', 'vehicleid'), COALESCE((SELECT MAX(vehicleid) FROM vehicles), 1), true);
SELECT setval(pg_get_serial_sequence('vehiclephotos', 'photoid'), COALESCE((SELECT MAX(photoid) FROM vehiclephotos), 1), true);
SELECT setval(pg_get_serial_sequence('reservationsmvp', 'reservationid'), COALESCE((SELECT MAX(reservationid) FROM reservationsmvp), 1), true);
SELECT setval(pg_get_serial_sequence('customers', 'custid'), COALESCE((SELECT MAX(custid) FROM customers), 1), true);
SELECT setval(pg_get_serial_sequence('cars', 'carid'), COALESCE((SELECT MAX(carid) FROM cars), 1), true);
SELECT setval(pg_get_serial_sequence('rental', 'rentid'), COALESCE((SELECT MAX(rentid) FROM rental), 1), true);
SELECT setval(pg_get_serial_sequence('paymentdetails', 'paymentid'), COALESCE((SELECT MAX(paymentid) FROM paymentdetails), 1), true);
```

## 4. Validate and cut over

Run `npm test` with `TEST_DATABASE_URL` pointed at a non-production PostgreSQL database, then smoke-test `/api/health/live`, `/api/health/ready`, `/api/public/vehicles`, reservation creation, and the admin vehicle flow. Legacy `/api/auth` is disabled by default and is not part of production validation. Point the deployed backend at the PostgreSQL connection only after validation succeeds; retain the MySQL backup for rollback of the migration process, not as a runtime dependency.
