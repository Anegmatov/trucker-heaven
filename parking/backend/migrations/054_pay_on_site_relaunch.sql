-- Relaunch without online payment: customers pay at Trucker Heaven.
-- Daily and Weekly parking is paid when the customer leaves; Monthly parking is
-- due on the 1st of each month. Staff record payments in the customer ledger.
ALTER TABLE parking_locations
  ALTER COLUMN payment_instructions SET DEFAULT 'Pay at the Trucker Heaven office. Daily and Weekly parking is paid when you leave; Monthly parking is due on the 1st of each month.';

UPDATE parking_locations
SET payment_instructions = 'Pay at the Trucker Heaven office. Daily and Weekly parking is paid when you leave; Monthly parking is due on the 1st of each month.'
WHERE payment_instructions IS NULL
   OR btrim(payment_instructions) = ''
   OR payment_instructions = 'Payment is due at the parking location.';
