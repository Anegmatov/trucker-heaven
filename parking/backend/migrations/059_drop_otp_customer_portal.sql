-- The OTP-based customer account portal (/api/customer/parking/v1 sessions) is
-- gone; My Parking uses the short-lived email+phone lookup grant instead.
-- Customer records, vehicles, ledger and lookup grants are untouched.
DROP TABLE IF EXISTS parking_customer_sessions;
DROP TABLE IF EXISTS parking_customer_auth_challenges;
