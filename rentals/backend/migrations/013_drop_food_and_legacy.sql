-- Food ordering moved to its own module and the development-only legacy API (cars/customers/rental/payments)
-- was removed, so their tables leave this database. Migration 002 created the legacy tables and the
-- rentaldetails view; migration 009 created the food tables. Both stay as history; this undoes their objects.
DROP VIEW IF EXISTS rentaldetails;
DROP TABLE IF EXISTS food_order_history;
DROP TABLE IF EXISTS food_order_items;
DROP TABLE IF EXISTS food_orders;
DROP TABLE IF EXISTS food_items;
DROP TABLE IF EXISTS food_categories;
DROP TABLE IF EXISTS paymentdetails;
DROP TABLE IF EXISTS rental;
DROP TABLE IF EXISTS cars;
DROP TABLE IF EXISTS customers;
