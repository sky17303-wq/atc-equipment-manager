CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('association', 'company', 'school', 'individual_teacher')),
  contact_email text,
  contact_phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid REFERENCES organizations(id),
  erp_user_id text UNIQUE,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  role text NOT NULL DEFAULT 'applicant' CHECK (role IN ('applicant', 'staff', 'admin', 'auditor')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_ssem CHECK (email LIKE '%@ssem.re.kr')
);

CREATE TABLE equipment_categories (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name text NOT NULL UNIQUE,
  code_prefix text,
  sort_order int NOT NULL DEFAULT 0
);

CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  type text NOT NULL DEFAULT 'storage',
  address text,
  manager_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE equipment_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  category_id uuid NOT NULL REFERENCES equipment_categories(id),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  total_quantity int NOT NULL DEFAULT 0 CHECK (total_quantity >= 0),
  unavailable_quantity int NOT NULL DEFAULT 0 CHECK (unavailable_quantity >= 0),
  rentable_quantity int NOT NULL DEFAULT 0 CHECK (rentable_quantity >= 0),
  tracking_mode text NOT NULL DEFAULT 'quantity' CHECK (tracking_mode IN ('quantity', 'asset', 'hybrid')),
  unit_type text NOT NULL DEFAULT 'quantity' CHECK (unit_type IN ('serialized', 'quantity', 'kit', 'bulk', 'book')),
  rentable boolean NOT NULL DEFAULT true,
  purchase_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_condition_balances (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id uuid NOT NULL REFERENCES equipment_items(id),
  location_id uuid REFERENCES locations(id),
  condition_status text NOT NULL CHECK (
    condition_status IN ('normal', 'damaged', 'needs_repair', 'lost', 'inspecting', 'unavailable')
  ),
  quantity int NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, location_id, condition_status)
);

CREATE TABLE equipment_assets (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id uuid NOT NULL REFERENCES equipment_items(id),
  location_id uuid REFERENCES locations(id),
  asset_tag text NOT NULL UNIQUE,
  serial_number text,
  status text NOT NULL DEFAULT 'available' CHECK (
    status IN ('available', 'reserved', 'checked_out', 'inspecting', 'damaged', 'lost', 'repairing', 'unavailable')
  ),
  condition_grade text NOT NULL DEFAULT 'A' CHECK (condition_grade IN ('A', 'B', 'C', 'unusable')),
  memo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE equipment_kits (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  rentable boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE equipment_kit_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  kit_id uuid NOT NULL REFERENCES equipment_kits(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES equipment_items(id),
  required_quantity int NOT NULL CHECK (required_quantity > 0),
  optional boolean NOT NULL DEFAULT false,
  replaceable boolean NOT NULL DEFAULT false
);

CREATE TABLE rental_applications (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  applicant_user_id uuid NOT NULL REFERENCES users(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  approved_by uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'submitted', 'approved', 'rejected', 'canceled', 'checked_out', 'returned', 'closed')
  ),
  requested_start_date date NOT NULL,
  requested_end_date date NOT NULL,
  purpose text NOT NULL,
  delivery_method text NOT NULL DEFAULT 'pickup' CHECK (delivery_method IN ('pickup', 'courier', 'internal_transfer')),
  applicant_memo text,
  staff_memo text,
  submitted_at timestamptz,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rental_date_range CHECK (requested_start_date <= requested_end_date)
);

CREATE TABLE rental_application_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  application_id uuid NOT NULL REFERENCES rental_applications(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES equipment_items(id),
  requested_quantity int NOT NULL CHECK (requested_quantity > 0),
  approved_quantity int CHECK (approved_quantity >= 0),
  availability_snapshot jsonb,
  memo text
);

CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  application_id uuid REFERENCES rental_applications(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES equipment_items(id),
  quantity int NOT NULL CHECK (quantity > 0),
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL DEFAULT 'tentative' CHECK (status IN ('tentative', 'confirmed', 'checked_out', 'canceled', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  CONSTRAINT reservation_date_range CHECK (start_date <= end_date)
);

CREATE INDEX reservations_lookup_idx
  ON reservations (item_id, status, start_date, end_date);

CREATE TABLE loans (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  application_id uuid NOT NULL REFERENCES rental_applications(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'partially_returned', 'returned', 'overdue')),
  checked_out_by uuid NOT NULL REFERENCES users(id),
  checked_out_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  checkout_memo text
);

CREATE TABLE loan_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  loan_id uuid NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES equipment_items(id),
  asset_id uuid REFERENCES equipment_assets(id),
  quantity int NOT NULL DEFAULT 1 CHECK (quantity > 0),
  checkout_condition text NOT NULL DEFAULT 'normal',
  tracking_mode text NOT NULL DEFAULT 'quantity' CHECK (tracking_mode IN ('quantity', 'asset', 'hybrid')),
  checkout_snapshot jsonb
);

CREATE TABLE returns (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  loan_id uuid NOT NULL REFERENCES loans(id),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'inspecting', 'completed', 'disputed')),
  received_by uuid NOT NULL REFERENCES users(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  inspected_by uuid REFERENCES users(id),
  inspected_at timestamptz,
  condition_summary text
);

CREATE TABLE return_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  return_id uuid NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  loan_item_id uuid REFERENCES loan_items(id),
  item_id uuid NOT NULL REFERENCES equipment_items(id),
  asset_id uuid REFERENCES equipment_assets(id),
  returned_quantity int NOT NULL DEFAULT 1 CHECK (returned_quantity > 0),
  normal_quantity int NOT NULL DEFAULT 0 CHECK (normal_quantity >= 0),
  damaged_quantity int NOT NULL DEFAULT 0 CHECK (damaged_quantity >= 0),
  repair_quantity int NOT NULL DEFAULT 0 CHECK (repair_quantity >= 0),
  lost_quantity int NOT NULL DEFAULT 0 CHECK (lost_quantity >= 0),
  result_status text NOT NULL DEFAULT 'mixed' CHECK (result_status IN ('normal', 'damaged', 'lost', 'needs_repair', 'mixed')),
  memo text,
  CONSTRAINT return_quantity_sum CHECK (
    returned_quantity = normal_quantity + damaged_quantity + repair_quantity + lost_quantity
  )
);

CREATE TABLE inventory_condition_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id uuid NOT NULL REFERENCES equipment_items(id),
  asset_id uuid REFERENCES equipment_assets(id),
  source_type text NOT NULL CHECK (source_type IN ('checkout', 'return', 'inspection', 'repair', 'manual')),
  source_id uuid,
  from_condition text CHECK (from_condition IN ('normal', 'damaged', 'needs_repair', 'lost', 'inspecting', 'unavailable')),
  to_condition text NOT NULL CHECK (to_condition IN ('normal', 'damaged', 'needs_repair', 'lost', 'inspecting', 'unavailable')),
  quantity int NOT NULL CHECK (quantity > 0),
  reason text NOT NULL,
  recorded_by uuid REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_adjustments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id uuid NOT NULL REFERENCES equipment_items(id),
  asset_id uuid REFERENCES equipment_assets(id),
  adjustment_type text NOT NULL CHECK (
    adjustment_type IN ('initial', 'purchase', 'donation', 'loss', 'damage', 'repair', 'disposal', 'correction')
  ),
  quantity_delta int NOT NULL,
  reason text NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE maintenance_tickets (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id uuid NOT NULL REFERENCES equipment_items(id),
  asset_id uuid REFERENCES equipment_assets(id),
  return_item_id uuid REFERENCES return_items(id),
  quantity int NOT NULL DEFAULT 1 CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  issue_type text NOT NULL CHECK (issue_type IN ('damage', 'missing_part', 'battery', 'software', 'unknown')),
  description text NOT NULL,
  opened_by uuid NOT NULL REFERENCES users(id),
  closed_by uuid REFERENCES users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE TABLE ai_conversations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid REFERENCES users(id),
  application_id uuid REFERENCES rental_applications(id),
  title text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_messages (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_tool_calls (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  message_id uuid NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  request_payload jsonb NOT NULL,
  response_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
