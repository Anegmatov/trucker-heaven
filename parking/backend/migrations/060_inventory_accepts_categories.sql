-- An inventory (zone + vehicle type) can accept other vehicle types too: the truck
-- daily area (101-129) is open to bobtails. A booking by an accepted type is placed in
-- this inventory and counts against its capacity like any other booking.
ALTER TABLE parking_inventory ADD COLUMN IF NOT EXISTS accepts_category_codes text[] NOT NULL DEFAULT '{}';
