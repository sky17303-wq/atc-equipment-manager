async function upsertPostgresInventory(client, item, source) {
  await client.query(
    `INSERT INTO equipment_items (
      id, code, name, category, total_quantity, unavailable_quantity,
      rentable_quantity, unit, unit_type, rentable, keywords, notes, source
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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
      source = EXCLUDED.source,
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
      item.notes || "",
      source
    ]
  );
}

async function upsertPostgresApplication(client, application) {
  await client.query(
    `INSERT INTO rental_applications (
      id, status, organization, applicant, email, start_date, end_date,
      purpose, delivery_method, staff_memo, timeline, created_at,
      approved_at, checked_out_at, returned_at, closed_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      organization = EXCLUDED.organization,
      applicant = EXCLUDED.applicant,
      email = EXCLUDED.email,
      start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date,
      purpose = EXCLUDED.purpose,
      delivery_method = EXCLUDED.delivery_method,
      staff_memo = EXCLUDED.staff_memo,
      timeline = EXCLUDED.timeline,
      approved_at = EXCLUDED.approved_at,
      checked_out_at = EXCLUDED.checked_out_at,
      returned_at = EXCLUDED.returned_at,
      closed_at = EXCLUDED.closed_at,
      updated_at = now()`,
    [
      application.id,
      application.status,
      application.organization || "미입력",
      application.applicant || "미입력",
      application.email || "user@ssem.re.kr",
      application.startDate,
      application.endDate,
      application.purpose || "교구 대여",
      application.deliveryMethod || "pickup",
      application.staffMemo || null,
      JSON.stringify(application.timeline || []),
      application.createdAt || new Date().toISOString(),
      application.approvedAt || null,
      application.checkedOutAt || null,
      application.returnedAt || null,
      application.closedAt || null
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

async function upsertPostgresReservation(client, reservation) {
  await client.query(
    `INSERT INTO reservations (
      id, application_id, item_id, quantity, start_date, end_date,
      status, organization, expires_at, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
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
      reservation.organization || "미입력",
      reservation.expiresAt || null,
      reservation.createdAt || new Date().toISOString()
    ]
  );
}

async function upsertPostgresLoan(client, loan) {
  await client.query(
    `INSERT INTO loans (
      id, application_id, status, organization, checked_out_by,
      checked_out_at, due_at, items, returned_at, closed_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
    ON CONFLICT (id) DO UPDATE SET
      application_id = EXCLUDED.application_id,
      status = EXCLUDED.status,
      organization = EXCLUDED.organization,
      checked_out_by = EXCLUDED.checked_out_by,
      checked_out_at = EXCLUDED.checked_out_at,
      due_at = EXCLUDED.due_at,
      items = EXCLUDED.items,
      returned_at = EXCLUDED.returned_at,
      closed_at = EXCLUDED.closed_at,
      updated_at = now()`,
    [
      loan.id,
      loan.applicationId,
      loan.status,
      loan.organization || "미입력",
      loan.checkedOutBy || "운영담당자",
      loan.checkedOutAt || new Date().toISOString(),
      loan.dueAt,
      JSON.stringify(loan.items || []),
      loan.returnedAt || null,
      loan.closedAt || null
    ]
  );
}

async function upsertPostgresReturnInspection(client, inspection) {
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
      inspection.organization || "미입력",
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

async function upsertPostgresOrganization(client, organization) {
  await client.query(
    `INSERT INTO equipment_organizations (
      id, name, type, status, manager_email, contact_email, notes, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      type = EXCLUDED.type,
      status = EXCLUDED.status,
      manager_email = EXCLUDED.manager_email,
      contact_email = EXCLUDED.contact_email,
      notes = EXCLUDED.notes,
      updated_at = now()`,
    [
      organization.id,
      organization.name,
      organization.type || "other",
      organization.status || "active",
      organization.managerEmail || null,
      organization.contactEmail || null,
      organization.notes || "",
      organization.createdAt || new Date().toISOString()
    ]
  );
}

async function upsertPostgresMember(client, member) {
  await client.query(
    `INSERT INTO equipment_members (
      id, erp_user_id, email, name, role, status, organization_id,
      organization, phone, memo, last_login_at, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
    ON CONFLICT (id) DO UPDATE SET
      erp_user_id = EXCLUDED.erp_user_id,
      email = EXCLUDED.email,
      name = EXCLUDED.name,
      role = EXCLUDED.role,
      status = EXCLUDED.status,
      organization_id = EXCLUDED.organization_id,
      organization = EXCLUDED.organization,
      phone = EXCLUDED.phone,
      memo = EXCLUDED.memo,
      last_login_at = EXCLUDED.last_login_at,
      updated_at = now()`,
    [
      member.id,
      member.erpUserId || null,
      member.email,
      member.name,
      member.role || "applicant",
      member.status || "pending",
      member.organizationId || null,
      member.organization || "미지정",
      member.phone || "",
      member.memo || "",
      member.lastLoginAt || null,
      member.createdAt || new Date().toISOString()
    ]
  );
}

async function upsertPostgresEvent(client, event) {
  await client.query(
    `INSERT INTO runtime_events (id, type, actor, role, payload, created_at)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (id) DO NOTHING`,
    [
      event.id,
      event.type,
      event.actor || "시스템",
      event.role || "system",
      JSON.stringify(event.payload || {}),
      event.createdAt || new Date().toISOString()
    ]
  );
}

module.exports = {
  upsertPostgresInventory,
  upsertPostgresApplication,
  upsertPostgresReservation,
  upsertPostgresLoan,
  upsertPostgresReturnInspection,
  upsertPostgresOrganization,
  upsertPostgresMember,
  upsertPostgresEvent
};
