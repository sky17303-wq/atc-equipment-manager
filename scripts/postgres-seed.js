const fs = require("node:fs/promises");
const path = require("node:path");

require("../server").loadEnv?.();

async function main() {
  const { Pool } = require("pg");
  const pool = new Pool(buildPgConfig());
  const seed = JSON.parse(await fs.readFile(path.join(__dirname, "..", "data", "seed-inventory.json"), "utf8"));
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await seedInventory(client, seed.inventory || []);
    await seedApplications(client, seed.applications || []);
    await seedReservations(client, seed.reservations || []);
    await seedReturns(client, seed.returnInspections || []);
    await client.query("COMMIT");
    console.log(`PostgreSQL seed completed: ${seed.inventory.length} items.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function buildPgConfig() {
  const ssl = String(process.env.PGSSL || "").toLowerCase();
  return {
    connectionString: process.env.DATABASE_URL || undefined,
    host: process.env.PGHOST || undefined,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    database: process.env.PGDATABASE || undefined,
    user: process.env.PGUSER || undefined,
    password: process.env.PGPASSWORD || undefined,
    ssl: ssl === "true" || ssl === "1" ? { rejectUnauthorized: false } : undefined
  };
}

async function seedInventory(client, inventory) {
  for (const item of inventory) {
    await client.query(
      `INSERT INTO equipment_items (
        id, code, name, category, total_quantity, unavailable_quantity,
        rentable_quantity, unit, unit_type, rentable, keywords, notes, source
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'seed')
      ON CONFLICT (id) DO UPDATE SET
        code = EXCLUDED.code,
        name = EXCLUDED.name,
        category = EXCLUDED.category,
        total_quantity = EXCLUDED.total_quantity,
        unavailable_quantity = EXCLUDED.unavailable_quantity,
        rentable_quantity = EXCLUDED.rentable_quantity,
        unit = EXCLUDED.unit,
        unit_type = EXCLUDED.unit_type,
        rentable = EXCLUDED.rentable,
        keywords = EXCLUDED.keywords,
        notes = EXCLUDED.notes,
        updated_at = now()`,
      [
        item.id,
        item.code,
        item.name,
        item.category,
        Number(item.totalQuantity || 0),
        Number(item.unavailableQuantity || 0),
        Number(item.rentableQuantity || 0),
        item.unit || "개",
        item.unitType || "quantity",
        item.rentable !== false,
        JSON.stringify(item.keywords || []),
        item.notes || ""
      ]
    );
  }
}

async function seedApplications(client, applications) {
  for (const application of applications) {
    await client.query(
      `INSERT INTO rental_applications (
        id, status, organization, applicant, email, start_date, end_date,
        purpose, delivery_method, timeline, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        organization = EXCLUDED.organization,
        applicant = EXCLUDED.applicant,
        email = EXCLUDED.email,
        start_date = EXCLUDED.start_date,
        end_date = EXCLUDED.end_date,
        purpose = EXCLUDED.purpose,
        delivery_method = EXCLUDED.delivery_method,
        updated_at = now()`,
      [
        application.id,
        application.status,
        application.organization,
        application.applicant,
        application.email,
        application.startDate,
        application.endDate,
        application.purpose,
        application.deliveryMethod || "pickup",
        JSON.stringify(application.timeline || []),
        application.createdAt || new Date().toISOString()
      ]
    );

    for (const item of application.items || []) {
      await client.query(
        `INSERT INTO rental_application_items (application_id, item_id, quantity)
        VALUES ($1,$2,$3)
        ON CONFLICT (application_id, item_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
        [application.id, item.itemId, Number(item.quantity || item.requestedQuantity || 0)]
      );
    }
  }
}

async function seedReservations(client, reservations) {
  for (const reservation of reservations) {
    await client.query(
      `INSERT INTO reservations (
        id, application_id, item_id, quantity, start_date, end_date,
        status, organization, expires_at, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (id) DO UPDATE SET
        application_id = EXCLUDED.application_id,
        item_id = EXCLUDED.item_id,
        quantity = EXCLUDED.quantity,
        start_date = EXCLUDED.start_date,
        end_date = EXCLUDED.end_date,
        status = EXCLUDED.status,
        organization = EXCLUDED.organization,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()`,
      [
        reservation.id,
        reservation.applicationId || null,
        reservation.itemId,
        Number(reservation.quantity || 0),
        reservation.startDate,
        reservation.endDate,
        reservation.status,
        reservation.organization,
        reservation.expiresAt || null,
        reservation.createdAt || new Date().toISOString()
      ]
    );
  }
}

async function seedReturns(client, returns) {
  for (const inspection of returns) {
    await client.query(
      `INSERT INTO return_inspections (
        id, status, organization, application_id, loan_id, item_id,
        checked_out_quantity, normal_quantity, damaged_quantity,
        repair_quantity, lost_quantity, inspected_by, inspected_at,
        note, tracking_mode
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        organization = EXCLUDED.organization,
        application_id = EXCLUDED.application_id,
        loan_id = EXCLUDED.loan_id,
        item_id = EXCLUDED.item_id,
        checked_out_quantity = EXCLUDED.checked_out_quantity,
        normal_quantity = EXCLUDED.normal_quantity,
        damaged_quantity = EXCLUDED.damaged_quantity,
        repair_quantity = EXCLUDED.repair_quantity,
        lost_quantity = EXCLUDED.lost_quantity,
        inspected_by = EXCLUDED.inspected_by,
        inspected_at = EXCLUDED.inspected_at,
        note = EXCLUDED.note,
        tracking_mode = EXCLUDED.tracking_mode`,
      [
        inspection.id,
        inspection.status || "completed",
        inspection.organization,
        inspection.applicationId || null,
        inspection.loanId || null,
        inspection.itemId,
        Number(inspection.checkedOutQuantity || 0),
        Number(inspection.normalQuantity || 0),
        Number(inspection.damagedQuantity || 0),
        Number(inspection.repairQuantity || 0),
        Number(inspection.lostQuantity || 0),
        inspection.inspectedBy || "운영담당자",
        inspection.inspectedAt || new Date().toISOString(),
        inspection.note || "",
        inspection.trackingMode || "quantity"
      ]
    );
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
