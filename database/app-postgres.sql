BEGIN;

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS equipment_organizations (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  type text NOT NULL DEFAULT 'other'
    CHECK (type IN ('association', 'school', 'company', 'individual_teacher', 'partner', 'other')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  manager_email text,
  contact_email text,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS equipment_members (
  id text PRIMARY KEY,
  erp_user_id text UNIQUE,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  role text NOT NULL DEFAULT 'applicant'
    CHECK (role IN ('applicant', 'staff', 'admin', 'auditor')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('active', 'pending', 'suspended', 'archived')),
  organization_id text REFERENCES equipment_organizations(id) ON DELETE SET NULL,
  organization text NOT NULL DEFAULT '미지정',
  phone text NOT NULL DEFAULT '',
  memo text NOT NULL DEFAULT '',
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS equipment_members_lookup_idx
  ON equipment_members (email, role, status);

CREATE TABLE IF NOT EXISTS equipment_items (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL,
  total_quantity int NOT NULL DEFAULT 0 CHECK (total_quantity >= 0),
  unavailable_quantity int NOT NULL DEFAULT 0 CHECK (unavailable_quantity >= 0),
  rentable_quantity int NOT NULL DEFAULT 0 CHECK (rentable_quantity >= 0),
  unit text NOT NULL DEFAULT '개',
  unit_type text NOT NULL DEFAULT 'quantity' CHECK (unit_type IN ('serialized', 'quantity', 'kit', 'bulk', 'book')),
  rentable boolean NOT NULL DEFAULT true,
  keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'seed',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rental_applications (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'canceled', 'checked_out', 'returned', 'closed')),
  organization text NOT NULL DEFAULT '미입력',
  applicant text NOT NULL DEFAULT '미입력',
  email text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  purpose text NOT NULL DEFAULT '교구 대여',
  delivery_method text NOT NULL DEFAULT 'pickup',
  staff_memo text,
  timeline jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  checked_out_at timestamptz,
  returned_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT application_date_range CHECK (start_date <= end_date)
);

CREATE TABLE IF NOT EXISTS rental_application_items (
  id bigserial PRIMARY KEY,
  application_id text NOT NULL REFERENCES rental_applications(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES equipment_items(id),
  quantity int NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, item_id)
);

CREATE TABLE IF NOT EXISTS reservations (
  id text PRIMARY KEY,
  application_id text REFERENCES rental_applications(id) ON DELETE SET NULL,
  item_id text NOT NULL REFERENCES equipment_items(id),
  quantity int NOT NULL CHECK (quantity > 0),
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('tentative', 'confirmed', 'checked_out', 'returned', 'canceled', 'expired')),
  organization text NOT NULL DEFAULT '미입력',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_date_range CHECK (start_date <= end_date)
);

CREATE INDEX IF NOT EXISTS reservations_lookup_idx
  ON reservations (item_id, status, start_date, end_date);

CREATE TABLE IF NOT EXISTS loans (
  id text PRIMARY KEY,
  application_id text NOT NULL REFERENCES rental_applications(id) ON DELETE CASCADE,
  status text NOT NULL,
  organization text NOT NULL DEFAULT '미입력',
  checked_out_by text NOT NULL,
  checked_out_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  returned_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS return_inspections (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'completed',
  organization text NOT NULL DEFAULT '미입력',
  application_id text REFERENCES rental_applications(id) ON DELETE SET NULL,
  loan_id text REFERENCES loans(id) ON DELETE SET NULL,
  item_id text NOT NULL REFERENCES equipment_items(id),
  checked_out_quantity int NOT NULL CHECK (checked_out_quantity > 0),
  normal_quantity int NOT NULL DEFAULT 0 CHECK (normal_quantity >= 0),
  damaged_quantity int NOT NULL DEFAULT 0 CHECK (damaged_quantity >= 0),
  repair_quantity int NOT NULL DEFAULT 0 CHECK (repair_quantity >= 0),
  lost_quantity int NOT NULL DEFAULT 0 CHECK (lost_quantity >= 0),
  inspected_by text NOT NULL DEFAULT '운영담당자',
  inspected_at timestamptz NOT NULL DEFAULT now(),
  note text NOT NULL DEFAULT '',
  tracking_mode text NOT NULL DEFAULT 'quantity',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_inspection_quantity_sum CHECK (
    checked_out_quantity = normal_quantity + damaged_quantity + repair_quantity + lost_quantity
  )
);

CREATE TABLE IF NOT EXISTS repair_tickets (
  id text PRIMARY KEY,
  inspection_id text REFERENCES return_inspections(id) ON DELETE SET NULL,
  application_id text REFERENCES rental_applications(id) ON DELETE SET NULL,
  item_id text NOT NULL REFERENCES equipment_items(id),
  quantity int NOT NULL CHECK (quantity > 0),
  issue_type text NOT NULL DEFAULT 'damaged'
    CHECK (issue_type IN ('damaged', 'repair', 'mixed')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_repair', 'resolved', 'scrapped')),
  returned_to_rentable int NOT NULL DEFAULT 0 CHECK (returned_to_rentable >= 0),
  note text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT '운영담당자',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT repair_ticket_returned_within_quantity CHECK (returned_to_rentable <= quantity)
);

CREATE TABLE IF NOT EXISTS runtime_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  actor text NOT NULL DEFAULT '시스템',
  role text NOT NULL DEFAULT 'system',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_settings (key, value)
VALUES (
  'runtime',
  '{"tentativeHoldHours":24,"returnBufferDays":1,"maxRentalDays":14,"emergencyReserveByItem":{}}'::jsonb
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO equipment_organizations (
  id, name, type, status, manager_email, contact_email, notes
) VALUES
  ('org-association', '컴퓨팅교사협회', 'association', 'active', 'staff@ssem.re.kr', 'staff@ssem.re.kr', '교구 운영 기본 기관'),
  ('org-school-seed', '새싹초등학교', 'school', 'active', 'user@ssem.re.kr', 'user@ssem.re.kr', '신청 테스트용 학교')
ON CONFLICT (id) DO NOTHING;

INSERT INTO equipment_members (
  id, erp_user_id, email, name, role, status, organization_id, organization, memo
) VALUES
  ('user-applicant', 'user-applicant', 'user@ssem.re.kr', '일반 대여자', 'applicant', 'active', 'org-school-seed', '새싹초등학교', '기본 목업 계정'),
  ('user-staff', 'user-staff', 'staff@ssem.re.kr', '운영담당자', 'staff', 'active', 'org-association', '컴퓨팅교사협회', '기본 목업 계정'),
  ('user-admin', 'user-admin', 'admin@ssem.re.kr', '관리자', 'admin', 'active', 'org-association', '컴퓨팅교사협회', '기본 목업 계정'),
  ('user-auditor', 'user-auditor', 'auditor@ssem.re.kr', '조회담당자', 'auditor', 'active', 'org-association', '컴퓨팅교사협회', '기본 목업 계정')
ON CONFLICT (id) DO NOTHING;

COMMIT;
