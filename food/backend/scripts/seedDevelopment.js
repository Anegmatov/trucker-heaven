require("dotenv").config();
const bcrypt = require("bcrypt");
const { loadConfig } = require("../lib/config");
const { createPool } = require("../db/connection");
const { categories, items } = require("../data/silkRoadMenu");

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function upsertUser(client, email, password, displayName, role) {
  const hash = await bcrypt.hash(password, 12);
  await client.query(`INSERT INTO admin_users (email,display_name,password_hash,role)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (LOWER(email)) DO UPDATE SET display_name=EXCLUDED.display_name,role=EXCLUDED.role`, [email.toLowerCase(), displayName, hash, role]);
}

async function main() {
  if ((process.env.NODE_ENV || "development") === "production") throw new Error("Development seed is disabled in production");
  const config = loadConfig();
  const pool = createPool(config);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO site_settings (id,business_name,hero_title,hero_subtitle,address,phone,email,map_url,parent_site_url,public_description,pickup_instructions)
      VALUES (1,'Silk Road Grill','Silk Road Grill','From the Silk Road to the open road.','8037 Eastgate Blvd, Mt. Juliet, TN 37122','','','','http://localhost:5173','Uzbek roots. International favorites. Food made for drivers, travelers, and everyone passing through Trucker Heaven.','Pick up at Silk Road Grill at Trucker Heaven.')
      ON CONFLICT (id) DO UPDATE SET business_name=EXCLUDED.business_name,hero_title=EXCLUDED.hero_title,hero_subtitle=EXCLUDED.hero_subtitle,address=EXCLUDED.address,phone=EXCLUDED.phone,email=EXCLUDED.email,map_url=EXCLUDED.map_url,parent_site_url=EXCLUDED.parent_site_url,public_description=EXCLUDED.public_description,pickup_instructions=EXCLUDED.pickup_instructions,updated_at=NOW()`);
    await client.query("DELETE FROM menu_items WHERE name LIKE 'Codex Recovery Menu %'");
    await client.query("UPDATE menu_items SET is_active=FALSE,is_available=FALSE,is_featured=FALSE");
    await client.query("UPDATE menu_categories SET is_active=FALSE");
    for (let index = 0; index < categories.length; index += 1) {
      const { name, slug } = categories[index];
      await client.query(`INSERT INTO menu_categories (name,slug,description,display_order,is_active)
        VALUES ($1,$2,'',$3,TRUE) ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description='',display_order=EXCLUDED.display_order,is_active=TRUE`, [name, slug, (index + 1) * 10]);
    }
    const categoryItemOrder = new Map();
    for (const [slug, name, description, price] of items) {
      const category = await client.query("SELECT id FROM menu_categories WHERE slug=$1", [slug]);
      const existing = await client.query("SELECT id FROM menu_items WHERE name=$1 ORDER BY id LIMIT 1", [name]);
      const order = (categoryItemOrder.get(slug) || 0) + 10;
      categoryItemOrder.set(slug, order);
      if (existing.rowCount) {
        await client.query(`UPDATE menu_items SET category_id=$2,description=$3,price_cents=$4,display_order=$5,is_active=TRUE,is_available=TRUE,is_featured=FALSE WHERE id=$1`, [existing.rows[0].id, category.rows[0].id, description, price, order]);
      } else {
        await client.query(`INSERT INTO menu_items (category_id,name,description,price_cents,display_order,is_featured,image_alt_text)
          VALUES ($1,$2,$3,$4,$5,FALSE,'')`, [category.rows[0].id, name, description, price, order]);
      }
    }
    await client.query("UPDATE daily_specials SET is_active=FALSE");
    for (let day = 0; day < 7; day += 1) {
      const weekend = day === 0 || day === 6;
      await client.query(`INSERT INTO business_hours (day_of_week,day_label,opens_at,closes_at,is_closed,display_order)
        VALUES ($1,$2,$3,$4,FALSE,$1) ON CONFLICT (day_of_week) DO UPDATE SET day_label=EXCLUDED.day_label,opens_at=EXCLUDED.opens_at,closes_at=EXCLUDED.closes_at,is_closed=FALSE,display_order=EXCLUDED.display_order`, [day, weekdays[day], weekend ? "07:00" : "06:00", weekend ? "22:00" : "23:00"]);
    }
    const features = [
      ["Dine In", "Relax, recharge, and enjoy a hot meal in our comfortable lounge.", "fork"],
      ["Takeout", "Order ahead and we will have it ready when you arrive.", "bag"],
      ["Truck Parking", "Convenient truck parking is available on site.", "truck"],
      ["Family Friendly", "A clean, welcoming stop for drivers and families.", "heart"]
    ];
    for (let index = 0; index < features.length; index += 1) {
      const [title, description, icon] = features[index];
      const existing = await client.query("SELECT id FROM lounge_features WHERE title=$1", [title]);
      if (existing.rowCount) await client.query("UPDATE lounge_features SET description=$2,icon_key=$3,display_order=$4,is_active=TRUE WHERE id=$1", [existing.rows[0].id, description, icon, (index + 1) * 10]);
      else await client.query("INSERT INTO lounge_features (title,description,icon_key,display_order) VALUES ($1,$2,$3,$4)", [title, description, icon, (index + 1) * 10]);
    }
    await client.query(`INSERT INTO gallery_items (image_path,alt_text,caption,display_order)
      VALUES ('assets/images/food/lounge-gallery.jpg','Warm seating inside the Trucker Heaven lounge','A comfortable place to recharge.',10)
      ON CONFLICT (image_path) DO NOTHING`);
    const ownerEmail = process.env.SEED_OWNER_EMAIL || "owner@truckerheaven.test";
    const ownerPassword = process.env.SEED_OWNER_PASSWORD || "ChangeMe-FoodOps-2026!";
    const staffEmail = process.env.SEED_STAFF_EMAIL || "staff@truckerheaven.test";
    const staffPassword = process.env.SEED_STAFF_PASSWORD || "ChangeMe-Staff-2026!";
    await upsertUser(client, ownerEmail, ownerPassword, "FoodOps Owner", "OWNER");
    await upsertUser(client, staffEmail, staffPassword, "FoodOps Staff", "STAFF");
    await client.query("COMMIT");
    console.log(`[seed] development content ready; OWNER ${ownerEmail}; STAFF ${staffEmail}`);
    console.log("[seed] change both development passwords before any shared use");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => { console.error("[seed] failed:", error.message); process.exitCode = 1; });
