-- =============================================================================
-- Migration 000 — Base schema (run-once baseline snapshot)
--
--   The application's original tables (regions, clients, candidates, placements,
--   invoices, payments, users, roles, audit_logs, notifications, ...), the AP
--   module (vendors, bills, bill_items, bill_approvals, vendor_payments) that
--   used to be created at runtime by modules/ap/ensureApSchema.js, and the
--   invoice template / reminder / settings tables that used to be created by
--   runtime ALTER TABLE in controllers. Captured from the live schema so the
--   whole database can be rebuilt from database/migrations/ alone:
--       000_base  ->  001..009 (idempotent deltas layer on top).
--
--   This is a baseline snapshot intended to run ONCE on an empty database.
--   CREATE TABLE/SEQUENCE/INDEX are guarded with IF NOT EXISTS; the PK/FK
--   constraints and column defaults below are not re-run-guarded, so re-running
--   000 on a populated DB is not supported (the idempotent deltas 001-009 are).
--   Columns later added by migrations (e.g. amount_base in 001, location_id /
--   *_minor in 004) may already be present here from the live snapshot; those
--   migrations use ADD COLUMN IF NOT EXISTS and remain no-ops.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.audit_logs (
    id bigint NOT NULL,
    user_id integer,
    user_email character varying(150),
    action character varying(100) NOT NULL,
    entity_type character varying(100) NOT NULL,
    entity_id integer,
    old_values jsonb,
    new_values jsonb,
    ip_address character varying(45),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS public.audit_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.audit_logs_id_seq OWNED BY public.audit_logs.id;

CREATE TABLE IF NOT EXISTS public.bill_approvals (
    id bigint NOT NULL,
    bill_id integer NOT NULL,
    step_no integer DEFAULT 1 NOT NULL,
    action character varying(30) NOT NULL,
    comments text,
    acted_by integer,
    acted_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS public.bill_approvals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.bill_approvals_id_seq OWNED BY public.bill_approvals.id;

CREATE TABLE IF NOT EXISTS public.bill_items (
    id bigint NOT NULL,
    bill_id integer NOT NULL,
    description text NOT NULL,
    quantity numeric(12,2) DEFAULT 1 NOT NULL,
    unit_price numeric(14,2) DEFAULT 0 NOT NULL,
    line_total numeric(14,2) DEFAULT 0 NOT NULL,
    expense_category character varying(100),
    cost_center character varying(100),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS public.bill_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.bill_items_id_seq OWNED BY public.bill_items.id;

CREATE TABLE IF NOT EXISTS public.bills (
    id integer NOT NULL,
    bill_number character varying(100) NOT NULL,
    vendor_id integer NOT NULL,
    region_id integer NOT NULL,
    bill_date date NOT NULL,
    due_date date NOT NULL,
    service_period_start date,
    service_period_end date,
    subtotal numeric(12,2) DEFAULT 0 NOT NULL,
    tax_amount numeric(12,2) DEFAULT 0 NOT NULL,
    total_amount numeric(12,2) DEFAULT 0 NOT NULL,
    currency character varying(10) NOT NULL,
    bill_status character varying(30) DEFAULT 'DRAFT'::character varying NOT NULL,
    approval_status character varying(30) DEFAULT 'NOT_SUBMITTED'::character varying NOT NULL,
    payment_paid_amount numeric(12,2) DEFAULT 0 NOT NULL,
    balance_outstanding numeric(12,2) DEFAULT 0 NOT NULL,
    invoice_reference character varying(100),
    external_reference character varying(100),
    notes text,
    tax_lines_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by integer,
    approved_by integer,
    approved_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp without time zone,
    exchange_rate numeric(18,8) DEFAULT 1 NOT NULL,
    amount_base numeric(14,2),
    CONSTRAINT bills_approval_status_check CHECK (((approval_status)::text = ANY ((ARRAY['NOT_SUBMITTED'::character varying, 'PENDING'::character varying, 'APPROVED'::character varying, 'REJECTED'::character varying])::text[]))),
    CONSTRAINT bills_status_check CHECK (((bill_status)::text = ANY ((ARRAY['DRAFT'::character varying, 'SUBMITTED'::character varying, 'APPROVED'::character varying, 'REJECTED'::character varying, 'PARTIALLY_PAID'::character varying, 'PAID'::character varying, 'OVERDUE'::character varying, 'CANCELLED'::character varying])::text[])))
);

CREATE SEQUENCE IF NOT EXISTS public.bills_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.bills_id_seq OWNED BY public.bills.id;

CREATE TABLE IF NOT EXISTS public.candidates (
    id integer NOT NULL,
    candidate_code character varying(50),
    full_name character varying(150) NOT NULL,
    email character varying(150),
    phone character varying(30),
    country character varying(100),
    skills text,
    notes text,
    status character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    created_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    job_title character varying(150),
    CONSTRAINT candidates_status_check CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'INACTIVE'::character varying])::text[])))
);

CREATE SEQUENCE IF NOT EXISTS public.candidates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.candidates_id_seq OWNED BY public.candidates.id;

CREATE TABLE IF NOT EXISTS public.clients (
    id integer NOT NULL,
    client_name character varying(200) NOT NULL,
    client_code character varying(50),
    region_id integer NOT NULL,
    billing_address text,
    tax_identifier character varying(100),
    currency character varying(10) NOT NULL,
    default_payment_terms character varying(50),
    default_invoice_cycle character varying(50),
    quickbooks_customer_id character varying(100),
    primary_contact_name character varying(150),
    primary_contact_email character varying(150),
    primary_contact_phone character varying(30),
    credit_limit numeric(14,2) DEFAULT 0,
    status character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    created_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT clients_status_check CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'INACTIVE'::character varying])::text[])))
);

CREATE SEQUENCE IF NOT EXISTS public.clients_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.clients_id_seq OWNED BY public.clients.id;

CREATE TABLE IF NOT EXISTS public.company_settings (
    id smallint DEFAULT 1 NOT NULL,
    group_currency character varying(10) DEFAULT 'USD'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT company_settings_singleton CHECK ((id = 1))
);

CREATE TABLE IF NOT EXISTS public.fiscal_years (
    id integer NOT NULL,
    year_label character varying(20) NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    status character varying(10) DEFAULT 'OPEN'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT fiscal_years_status_check CHECK (((status)::text = ANY ((ARRAY['OPEN'::character varying, 'CLOSED'::character varying])::text[])))
);

CREATE SEQUENCE IF NOT EXISTS public.fiscal_years_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.fiscal_years_id_seq OWNED BY public.fiscal_years.id;

CREATE TABLE IF NOT EXISTS public.invoice_items (
    id bigint NOT NULL,
    invoice_id bigint NOT NULL,
    description text NOT NULL,
    quantity numeric(12,2) DEFAULT 1 NOT NULL,
    unit_price numeric(14,2) DEFAULT 0 NOT NULL,
    line_total numeric(14,2) DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS public.invoice_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.invoice_items_id_seq OWNED BY public.invoice_items.id;

CREATE TABLE IF NOT EXISTS public.invoice_payments (
    id bigint NOT NULL,
    invoice_id bigint NOT NULL,
    payment_date date NOT NULL,
    amount numeric(14,2) NOT NULL,
    payment_mode character varying(50),
    reference_number character varying(100),
    notes text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS public.invoice_payments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.invoice_payments_id_seq OWNED BY public.invoice_payments.id;

CREATE TABLE IF NOT EXISTS public.invoice_reminder_logs (
    id bigint NOT NULL,
    invoice_id integer NOT NULL,
    reminder_key character varying(80) NOT NULL,
    sent_on date NOT NULL,
    channel character varying(30) DEFAULT 'IN_APP'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS public.invoice_reminder_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.invoice_reminder_logs_id_seq OWNED BY public.invoice_reminder_logs.id;

CREATE TABLE IF NOT EXISTS public.invoice_reminder_settings (
    id integer NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    days_before_due integer DEFAULT 3 NOT NULL,
    send_on_due boolean DEFAULT true NOT NULL,
    overdue_days integer[] DEFAULT ARRAY[1, 3, 7] NOT NULL,
    channels_json jsonb DEFAULT '{"email": false, "in_app": true}'::jsonb NOT NULL,
    updated_by integer,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT invoice_reminder_settings_id_check CHECK ((id = 1))
);

CREATE TABLE IF NOT EXISTS public.invoice_reminder_templates (
    reminder_type character varying(30) NOT NULL,
    subject_template text NOT NULL,
    body_template text NOT NULL,
    updated_by integer,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS public.invoice_templates (
    id bigint NOT NULL,
    template_name character varying(120) NOT NULL,
    logo_url text,
    company_name character varying(200),
    company_address text,
    company_tax_number character varying(120),
    payment_terms_label character varying(80),
    tax_rate numeric(10,2) DEFAULT 0,
    default_notes text,
    footer_text text,
    currency character varying(10) DEFAULT 'USD'::character varying,
    invoice_layout character varying(30) DEFAULT 'CLASSIC'::character varying,
    custom_fields_json jsonb DEFAULT '[]'::jsonb,
    status character varying(20) DEFAULT 'ACTIVE'::character varying,
    created_by bigint,
    updated_by bigint,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    template_cards_json jsonb DEFAULT '[]'::jsonb
);

CREATE SEQUENCE IF NOT EXISTS public.invoice_templates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.invoice_templates_id_seq OWNED BY public.invoice_templates.id;

CREATE TABLE IF NOT EXISTS public.invoices (
    id integer NOT NULL,
    invoice_number character varying(100) NOT NULL,
    placement_id integer NOT NULL,
    client_id integer NOT NULL,
    region_id integer NOT NULL,
    invoice_date date NOT NULL,
    due_date date NOT NULL,
    billing_period_start date,
    billing_period_end date,
    hours_or_units numeric(10,2) DEFAULT 0 NOT NULL,
    bill_rate numeric(12,2) DEFAULT 0 NOT NULL,
    subtotal numeric(12,2) DEFAULT 0 NOT NULL,
    tax_amount numeric(12,2) DEFAULT 0 NOT NULL,
    total_amount numeric(12,2) DEFAULT 0 NOT NULL,
    currency character varying(10) NOT NULL,
    invoice_status character varying(30) DEFAULT 'DRAFT'::character varying NOT NULL,
    quickbooks_invoice_id character varying(100),
    quickbooks_sync_status character varying(30) DEFAULT 'NOT_SYNCED'::character varying NOT NULL,
    payment_received_amount numeric(12,2) DEFAULT 0 NOT NULL,
    balance_outstanding numeric(12,2) DEFAULT 0 NOT NULL,
    sent_at timestamp without time zone,
    notes text,
    created_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    tax_lines_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    invoice_template character varying(30) DEFAULT 'CLASSIC'::character varying,
    invoice_template_id bigint,
    invoice_template_name character varying(140),
    invoice_template_snapshot_json jsonb DEFAULT '{}'::jsonb,
    template_custom_fields_json jsonb DEFAULT '[]'::jsonb,
    exchange_rate numeric(18,8) DEFAULT 1 NOT NULL,
    amount_base numeric(14,2),
    CONSTRAINT invoices_invoice_status_check CHECK (((invoice_status)::text = ANY ((ARRAY['DRAFT'::character varying, 'GENERATED'::character varying, 'SENT'::character varying, 'PARTIALLY_PAID'::character varying, 'PAID'::character varying, 'OVERDUE'::character varying, 'CANCELLED'::character varying])::text[]))),
    CONSTRAINT invoices_quickbooks_sync_status_check CHECK (((quickbooks_sync_status)::text = ANY ((ARRAY['NOT_SYNCED'::character varying, 'SYNCED'::character varying, 'FAILED'::character varying])::text[])))
);

CREATE SEQUENCE IF NOT EXISTS public.invoices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.invoices_id_seq OWNED BY public.invoices.id;

CREATE TABLE IF NOT EXISTS public.notifications (
    id bigint NOT NULL,
    user_id integer NOT NULL,
    title character varying(200) NOT NULL,
    message text NOT NULL,
    type character varying(50) DEFAULT 'INFO'::character varying NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    entity_type character varying(100),
    entity_id integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS public.notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;

CREATE TABLE IF NOT EXISTS public.payments (
    id integer NOT NULL,
    invoice_id integer NOT NULL,
    payment_date date NOT NULL,
    amount_received numeric(12,2) NOT NULL,
    payment_mode character varying(50),
    reference_number character varying(100),
    exchange_rate numeric(12,4),
    amount_in_base_currency numeric(12,2),
    notes text,
    created_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    payment_code character varying(100),
    tds_applicable boolean DEFAULT false,
    tds_percent numeric(6,2),
    tds_amount numeric(12,2) DEFAULT 0,
    currency character varying(10),
    fx_gain_loss numeric(14,2) DEFAULT 0 NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS public.payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.payments_id_seq OWNED BY public.payments.id;

CREATE TABLE IF NOT EXISTS public.placements (
    id integer NOT NULL,
    placement_code character varying(50),
    candidate_id integer NOT NULL,
    region_id integer NOT NULL,
    client_id integer NOT NULL,
    end_client_name character varying(200),
    vendor_name character varying(200),
    recruiter_id integer,
    account_manager_id integer,
    job_title character varying(150) NOT NULL,
    employment_type character varying(50) NOT NULL,
    placement_status character varying(30) DEFAULT 'ACTIVE'::character varying NOT NULL,
    billing_type character varying(30) NOT NULL,
    bill_rate numeric(12,2) DEFAULT 0 NOT NULL,
    pay_rate numeric(12,2) DEFAULT 0,
    currency character varying(10) NOT NULL,
    expected_hours_per_month numeric(10,2) DEFAULT 0,
    monthly_billing_amount numeric(12,2) DEFAULT 0,
    one_time_fee_amount numeric(12,2) DEFAULT 0,
    invoice_cycle character varying(30) NOT NULL,
    payment_terms character varying(30) DEFAULT 'NET_30'::character varying NOT NULL,
    custom_payment_terms_days integer,
    po_number character varying(100),
    sow_number character varying(100),
    tax_applicable boolean DEFAULT false NOT NULL,
    tax_percent numeric(5,2) DEFAULT 0 NOT NULL,
    start_date date NOT NULL,
    end_date date,
    notes text,
    created_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT placements_billing_type_check CHECK (((billing_type)::text = ANY ((ARRAY['HOURLY'::character varying, 'MONTHLY'::character varying, 'ONE_TIME'::character varying])::text[]))),
    CONSTRAINT placements_employment_type_check CHECK (((employment_type)::text = ANY ((ARRAY['CONTRACT'::character varying, 'C2C'::character varying, 'W2'::character varying, 'FULL_TIME'::character varying, 'PERMANENT'::character varying])::text[]))),
    CONSTRAINT placements_invoice_cycle_check CHECK (((invoice_cycle)::text = ANY ((ARRAY['WEEKLY'::character varying, 'BIWEEKLY'::character varying, 'MONTHLY'::character varying])::text[]))),
    CONSTRAINT placements_payment_terms_check CHECK (((payment_terms)::text = ANY ((ARRAY['NET_15'::character varying, 'NET_30'::character varying, 'NET_45'::character varying, 'CUSTOM'::character varying])::text[]))),
    CONSTRAINT placements_placement_status_check CHECK (((placement_status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'ON_HOLD'::character varying, 'ENDED'::character varying, 'CANCELLED'::character varying])::text[])))
);

CREATE SEQUENCE IF NOT EXISTS public.placements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.placements_id_seq OWNED BY public.placements.id;

CREATE TABLE IF NOT EXISTS public.regions (
    id integer NOT NULL,
    region_name character varying(100) NOT NULL,
    region_code character varying(20) NOT NULL,
    default_currency character varying(10) NOT NULL,
    status character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    company_name character varying(200),
    company_address text,
    company_id_label character varying(100),
    company_id_value character varying(150),
    logo_url text,
    invoice_terms_label character varying(100),
    bank_name character varying(150),
    bank_account_name character varying(200),
    bank_account_number character varying(100),
    bank_routing_number character varying(100),
    bank_swift_ifsc character varying(100),
    bank_branch_details text,
    country_name character varying(100),
    country_code character varying(10),
    invoice_template character varying(30) DEFAULT 'CLASSIC'::character varying,
    invoice_brand_primary_color character varying(7) DEFAULT '#111827'::character varying,
    invoice_brand_accent_color character varying(7) DEFAULT '#1D4ED8'::character varying,
    invoice_brand_footer_note text,
    date_format character varying(20) DEFAULT 'MM/DD/YYYY'::character varying,
    currency_format character varying(20) DEFAULT 'SYMBOL'::character varying,
    customer_label character varying(80) DEFAULT 'Client'::character varying,
    warn_duplicate_invoice_number boolean DEFAULT true,
    first_month_fiscal_year smallint DEFAULT 1,
    first_month_tax_year smallint DEFAULT 4,
    functional_currency character varying(10),
    CONSTRAINT regions_status_check CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'INACTIVE'::character varying])::text[])))
);

CREATE SEQUENCE IF NOT EXISTS public.regions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.regions_id_seq OWNED BY public.regions.id;

CREATE TABLE IF NOT EXISTS public.roles (
    id integer NOT NULL,
    role_name character varying(100) NOT NULL,
    description text,
    status character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT roles_status_check CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'INACTIVE'::character varying])::text[])))
);

CREATE SEQUENCE IF NOT EXISTS public.roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.roles_id_seq OWNED BY public.roles.id;

CREATE TABLE IF NOT EXISTS public.users (
    id integer NOT NULL,
    full_name character varying(150) NOT NULL,
    email character varying(150) NOT NULL,
    password_hash text NOT NULL,
    role_id integer NOT NULL,
    phone character varying(30),
    status character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    last_login_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT users_status_check CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'INACTIVE'::character varying])::text[])))
);

CREATE SEQUENCE IF NOT EXISTS public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;

CREATE TABLE IF NOT EXISTS public.vendor_payments (
    id integer NOT NULL,
    payment_code character varying(100),
    bill_id integer NOT NULL,
    payment_date date NOT NULL,
    amount_paid numeric(12,2) NOT NULL,
    payment_method character varying(50),
    reference_number character varying(100),
    notes text,
    created_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    exchange_rate numeric(18,8) DEFAULT 1 NOT NULL,
    amount_base numeric(14,2),
    fx_gain_loss numeric(14,2) DEFAULT 0 NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS public.vendor_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.vendor_payments_id_seq OWNED BY public.vendor_payments.id;

CREATE TABLE IF NOT EXISTS public.vendors (
    id integer NOT NULL,
    vendor_code character varying(50),
    vendor_name character varying(200) NOT NULL,
    region_id integer NOT NULL,
    billing_address text,
    tax_identifier character varying(100),
    currency character varying(10) DEFAULT 'USD'::character varying NOT NULL,
    default_payment_terms character varying(50) DEFAULT 'NET_30'::character varying,
    primary_contact_name character varying(150),
    primary_contact_email character varying(150),
    primary_contact_phone character varying(30),
    bank_name character varying(150),
    bank_account_name character varying(200),
    bank_account_number character varying(100),
    bank_routing_number character varying(100),
    bank_swift_ifsc character varying(100),
    status character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    created_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp without time zone,
    CONSTRAINT vendors_status_check CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'INACTIVE'::character varying])::text[])))
);

CREATE SEQUENCE IF NOT EXISTS public.vendors_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.vendors_id_seq OWNED BY public.vendors.id;

ALTER TABLE ONLY public.audit_logs ALTER COLUMN id SET DEFAULT nextval('public.audit_logs_id_seq'::regclass);

ALTER TABLE ONLY public.bill_approvals ALTER COLUMN id SET DEFAULT nextval('public.bill_approvals_id_seq'::regclass);

ALTER TABLE ONLY public.bill_items ALTER COLUMN id SET DEFAULT nextval('public.bill_items_id_seq'::regclass);

ALTER TABLE ONLY public.bills ALTER COLUMN id SET DEFAULT nextval('public.bills_id_seq'::regclass);

ALTER TABLE ONLY public.candidates ALTER COLUMN id SET DEFAULT nextval('public.candidates_id_seq'::regclass);

ALTER TABLE ONLY public.clients ALTER COLUMN id SET DEFAULT nextval('public.clients_id_seq'::regclass);

ALTER TABLE ONLY public.fiscal_years ALTER COLUMN id SET DEFAULT nextval('public.fiscal_years_id_seq'::regclass);

ALTER TABLE ONLY public.invoice_items ALTER COLUMN id SET DEFAULT nextval('public.invoice_items_id_seq'::regclass);

ALTER TABLE ONLY public.invoice_payments ALTER COLUMN id SET DEFAULT nextval('public.invoice_payments_id_seq'::regclass);

ALTER TABLE ONLY public.invoice_reminder_logs ALTER COLUMN id SET DEFAULT nextval('public.invoice_reminder_logs_id_seq'::regclass);

ALTER TABLE ONLY public.invoice_templates ALTER COLUMN id SET DEFAULT nextval('public.invoice_templates_id_seq'::regclass);

ALTER TABLE ONLY public.invoices ALTER COLUMN id SET DEFAULT nextval('public.invoices_id_seq'::regclass);

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);

ALTER TABLE ONLY public.payments ALTER COLUMN id SET DEFAULT nextval('public.payments_id_seq'::regclass);

ALTER TABLE ONLY public.placements ALTER COLUMN id SET DEFAULT nextval('public.placements_id_seq'::regclass);

ALTER TABLE ONLY public.regions ALTER COLUMN id SET DEFAULT nextval('public.regions_id_seq'::regclass);

ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);

ALTER TABLE ONLY public.vendor_payments ALTER COLUMN id SET DEFAULT nextval('public.vendor_payments_id_seq'::regclass);

ALTER TABLE ONLY public.vendors ALTER COLUMN id SET DEFAULT nextval('public.vendors_id_seq'::regclass);

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.bill_approvals
    ADD CONSTRAINT bill_approvals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.bill_items
    ADD CONSTRAINT bill_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.bills
    ADD CONSTRAINT bills_bill_number_key UNIQUE (bill_number);

ALTER TABLE ONLY public.bills
    ADD CONSTRAINT bills_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_candidate_code_key UNIQUE (candidate_code);

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_client_code_key UNIQUE (client_code);

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.company_settings
    ADD CONSTRAINT company_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fiscal_years
    ADD CONSTRAINT fiscal_years_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fiscal_years
    ADD CONSTRAINT fiscal_years_year_label_key UNIQUE (year_label);

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invoice_payments
    ADD CONSTRAINT invoice_payments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invoice_reminder_logs
    ADD CONSTRAINT invoice_reminder_logs_invoice_id_reminder_key_sent_on_chann_key UNIQUE (invoice_id, reminder_key, sent_on, channel);

ALTER TABLE ONLY public.invoice_reminder_logs
    ADD CONSTRAINT invoice_reminder_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invoice_reminder_settings
    ADD CONSTRAINT invoice_reminder_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invoice_reminder_templates
    ADD CONSTRAINT invoice_reminder_templates_pkey PRIMARY KEY (reminder_type);

ALTER TABLE ONLY public.invoice_templates
    ADD CONSTRAINT invoice_templates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invoice_templates
    ADD CONSTRAINT invoice_templates_template_name_key UNIQUE (template_name);

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_invoice_number_key UNIQUE (invoice_number);

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_payment_code_key UNIQUE (payment_code);

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.placements
    ADD CONSTRAINT placements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.placements
    ADD CONSTRAINT placements_placement_code_key UNIQUE (placement_code);

ALTER TABLE ONLY public.regions
    ADD CONSTRAINT regions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.regions
    ADD CONSTRAINT regions_region_code_key UNIQUE (region_code);

ALTER TABLE ONLY public.regions
    ADD CONSTRAINT regions_region_name_key UNIQUE (region_name);

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_role_name_key UNIQUE (role_name);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vendor_payments
    ADD CONSTRAINT vendor_payments_payment_code_key UNIQUE (payment_code);

ALTER TABLE ONLY public.vendor_payments
    ADD CONSTRAINT vendor_payments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_vendor_code_key UNIQUE (vendor_code);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs USING btree (created_at);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON public.audit_logs USING btree (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON public.audit_logs USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_bill_approvals_bill_id ON public.bill_approvals USING btree (bill_id);

CREATE INDEX IF NOT EXISTS idx_bill_items_bill_id ON public.bill_items USING btree (bill_id);

CREATE INDEX IF NOT EXISTS idx_bills_approval_status ON public.bills USING btree (approval_status);

CREATE INDEX IF NOT EXISTS idx_bills_due_date ON public.bills USING btree (due_date);

CREATE INDEX IF NOT EXISTS idx_bills_region_id ON public.bills USING btree (region_id);

CREATE INDEX IF NOT EXISTS idx_bills_status ON public.bills USING btree (bill_status);

CREATE INDEX IF NOT EXISTS idx_bills_vendor_id ON public.bills USING btree (vendor_id);

CREATE INDEX IF NOT EXISTS idx_candidates_created_by ON public.candidates USING btree (created_by);

CREATE INDEX IF NOT EXISTS idx_clients_region_id ON public.clients USING btree (region_id);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON public.invoice_items USING btree (invoice_id);

CREATE INDEX IF NOT EXISTS idx_invoices_client_id ON public.invoices USING btree (client_id);

CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON public.invoices USING btree (due_date);

CREATE INDEX IF NOT EXISTS idx_invoices_invoice_date ON public.invoices USING btree (invoice_date);

CREATE INDEX IF NOT EXISTS idx_invoices_placement_id ON public.invoices USING btree (placement_id);

CREATE INDEX IF NOT EXISTS idx_invoices_region_id ON public.invoices USING btree (region_id);

CREATE INDEX IF NOT EXISTS idx_invoices_status ON public.invoices USING btree (invoice_status);

CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON public.notifications USING btree (is_read);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON public.notifications USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON public.payments USING btree (invoice_id);

CREATE INDEX IF NOT EXISTS idx_payments_payment_code ON public.payments USING btree (payment_code);

CREATE INDEX IF NOT EXISTS idx_payments_payment_date ON public.payments USING btree (payment_date);

CREATE INDEX IF NOT EXISTS idx_placements_account_manager_id ON public.placements USING btree (account_manager_id);

CREATE INDEX IF NOT EXISTS idx_placements_candidate_id ON public.placements USING btree (candidate_id);

CREATE INDEX IF NOT EXISTS idx_placements_client_id ON public.placements USING btree (client_id);

CREATE INDEX IF NOT EXISTS idx_placements_recruiter_id ON public.placements USING btree (recruiter_id);

CREATE INDEX IF NOT EXISTS idx_placements_region_id ON public.placements USING btree (region_id);

CREATE INDEX IF NOT EXISTS idx_placements_start_date ON public.placements USING btree (start_date);

CREATE INDEX IF NOT EXISTS idx_placements_status ON public.placements USING btree (placement_status);

CREATE INDEX IF NOT EXISTS idx_users_role_id ON public.users USING btree (role_id);

CREATE INDEX IF NOT EXISTS idx_vendor_payments_bill_id ON public.vendor_payments USING btree (bill_id);

CREATE INDEX IF NOT EXISTS idx_vendor_payments_payment_date ON public.vendor_payments USING btree (payment_date);

CREATE INDEX IF NOT EXISTS idx_vendors_region_id ON public.vendors USING btree (region_id);

CREATE INDEX IF NOT EXISTS idx_vendors_status ON public.vendors USING btree (status);

ALTER TABLE ONLY public.bill_approvals
    ADD CONSTRAINT bill_approvals_acted_by_fkey FOREIGN KEY (acted_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.bill_approvals
    ADD CONSTRAINT bill_approvals_bill_id_fkey FOREIGN KEY (bill_id) REFERENCES public.bills(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.bill_items
    ADD CONSTRAINT bill_items_bill_id_fkey FOREIGN KEY (bill_id) REFERENCES public.bills(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.bills
    ADD CONSTRAINT bills_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.bills
    ADD CONSTRAINT bills_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.bills
    ADD CONSTRAINT bills_region_id_fkey FOREIGN KEY (region_id) REFERENCES public.regions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.bills
    ADD CONSTRAINT bills_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT fk_candidates_created_by FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT fk_clients_created_by FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT fk_clients_region FOREIGN KEY (region_id) REFERENCES public.regions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT fk_invoices_client FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT fk_invoices_created_by FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT fk_invoices_placement FOREIGN KEY (placement_id) REFERENCES public.placements(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT fk_invoices_region FOREIGN KEY (region_id) REFERENCES public.regions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT fk_payments_created_by FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT fk_payments_invoice FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.placements
    ADD CONSTRAINT fk_placements_account_manager FOREIGN KEY (account_manager_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.placements
    ADD CONSTRAINT fk_placements_candidate FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.placements
    ADD CONSTRAINT fk_placements_client FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.placements
    ADD CONSTRAINT fk_placements_created_by FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.placements
    ADD CONSTRAINT fk_placements_recruiter FOREIGN KEY (recruiter_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.placements
    ADD CONSTRAINT fk_placements_region FOREIGN KEY (region_id) REFERENCES public.regions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.invoice_payments
    ADD CONSTRAINT invoice_payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.vendor_payments
    ADD CONSTRAINT vendor_payments_bill_id_fkey FOREIGN KEY (bill_id) REFERENCES public.bills(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.vendor_payments
    ADD CONSTRAINT vendor_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_region_id_fkey FOREIGN KEY (region_id) REFERENCES public.regions(id) ON DELETE RESTRICT;

COMMIT;
