# Trucker Heaven Rentals customer page

Static, single-page site (no build step) designed as the Rentals page of truckerheaven.com: same header,
colors and display type as the main site. Customers browse the cars, pick dates on a car's page, leave
their details and get a reservation page. Nothing is charged online; they pay at the counter.

## Run locally

Start the backend on port 3000, then serve this directory:

```bash
python3 -m http.server 5174 --directory frontend-customer
```

Open `http://localhost:5174/`.

- `#/` our cars, with filters once there are a few (`#/?q=…&category=…&seats=…&maxRate=…&sort=…`)
- `#/v/<id>?pickupAt=2026-10-12T09:00&returnAt=…` a car: photos, specs, pick your dates (checks availability)
- `#/v/<id>/details?pickupAt=…&returnAt=…` your details, then the request is sent
- `#t=<access code>` the customer's reservation page (link sent by text when `CUSTOMER_SITE_URL` is set on the API),
  also accepts the short-lived grant from the email + phone lookup
- `#find` find a reservation with the email and mobile number it was made with

Old addresses (`fleet.html?…`, `vehicle.html?id=…`, `reservation.html`) redirect to the new routes.

## Photos

`assets/photos/` holds licensed stock photos (see `CREDITS.md`). A car without an uploaded photo shows the
stock photo for its type with a "Similar vehicle shown" tag; a photo uploaded in the staff site replaces it.
Fonts in `assets/fonts/` are the self-hosted fallback for Bahnschrift Condensed.

## Tests

```bash
node --test frontend-customer/test/
```
