# Trucker Heaven

One repo, one API process, three products.

| Folder | What it is |
| --- | --- |
| `api/` | The shared API: `node api/server.js` boots the parking, rentals and food backends in one process and routes each request to a module by hostname. This is the one Render web service. |
| `parking/` | Truck parking: `backend/` (Express module), `frontend-customer-classic/` (customer site), `frontend-admin/` (staff site), `frontend-customer/` (map page). |
| `rentals/` | Car rentals: `backend/`, `frontend-customer/`, `frontend-admin/`. |
| `food/` | Silk Road Grill ordering: `backend/`, `frontend-public/`, `frontend-admin/`. |

Each backend keeps its own database, env prefix (`PARKING_*`, `RENTALS_*`, `FOOD_*`) and migrations. See `api/.env.example`.

```bash
npm install            # one node_modules for everything
cp api/.env.example api/.env   # fill in the database URLs
npm start              # http://parking.localhost:3000, rentals.localhost:3000, food.localhost:3000
npm test
```

Module histories live in the archived `trucker-heaven-parking`, `trucker-heaven-rentals` and `trucker-heaven-food` repos.
