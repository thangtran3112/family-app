import { type Kysely, sql } from "kysely";

const legacyTemplateKeys = [
  "advertising",
  "car-and-truck",
  "contract-labor",
  "insurance",
  "office-expenses",
  "rent-or-lease",
  "supplies",
  "utilities",
] as const;

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS app.spending_categories_active_tenant_name_unique
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX spending_categories_active_normalized_name_unique
      ON app.spending_categories (tenant_id, lower(trim(name)))
      WHERE status = 'active'
  `.execute(database);

  await sql`
    CREATE TABLE app.industry_spending_category_templates (
      industry_code text NOT NULL
        REFERENCES app.business_industries(code),
      template_key text NOT NULL
        REFERENCES app.spending_category_templates(template_key),
      sort_order integer NOT NULL,
      PRIMARY KEY (industry_code, template_key),
      CONSTRAINT industry_spending_category_templates_order_unique
        UNIQUE (industry_code, sort_order),
      CONSTRAINT industry_spending_category_templates_order_check
        CHECK (sort_order BETWEEN 1 AND 5)
    )
  `.execute(database);

  await sql`
    DELETE FROM app.spending_category_templates
    WHERE template_key IN (${sql.join(legacyTemplateKeys)})
  `.execute(database);

  await sql`
    INSERT INTO app.spending_category_templates
      (template_key, name, description, color, icon)
    VALUES
      ('food-inventory', 'Food Inventory', 'Food and ingredient inventory', '#B45309', 'basket'),
      ('beverages', 'Beverages', 'Beverage inventory and service costs', '#0369A1', 'cup-soda'),
      ('kitchen-supplies', 'Kitchen Supplies', 'Kitchen tools and consumables', '#7C3AED', 'utensils'),
      ('delivery-fees', 'Delivery Fees', 'Delivery and courier costs', '#0F766E', 'truck'),
      ('equipment-maintenance', 'Equipment Maintenance', 'Maintenance for business equipment', '#4F46E5', 'wrench'),
      ('beauty-supplies', 'Beauty Supplies', 'Beauty products and consumables', '#BE123C', 'sparkles'),
      ('linens-laundry', 'Linens and Laundry', 'Linens, laundry, and cleaning service', '#0369A1', 'shirt'),
      ('booth-equipment', 'Booth Equipment', 'Booth and salon equipment', '#7C3AED', 'armchair'),
      ('booking-fees', 'Booking Fees', 'Booking and appointment platform costs', '#0F766E', 'calendar'),
      ('licensing', 'Licensing', 'Business licenses and permits', '#B45309', 'badge-check'),
      ('learning-supplies', 'Learning Supplies', 'Learning materials and activities', '#4F46E5', 'book-open'),
      ('meals-snacks', 'Meals and Snacks', 'Meals, snacks, and food service', '#B45309', 'utensils'),
      ('toys-equipment', 'Toys and Equipment', 'Toys and child-care equipment', '#BE123C', 'blocks'),
      ('cleaning-safety', 'Cleaning and Safety', 'Cleaning and child safety supplies', '#15803D', 'shield-check'),
      ('licensing-training', 'Licensing and Training', 'Licensing, training, and compliance', '#0369A1', 'graduation-cap'),
      ('resale-inventory', 'Resale Inventory', 'Inventory purchased for resale', '#B45309', 'shopping-bag'),
      ('packaging', 'Packaging', 'Packaging and shopping materials', '#7C3AED', 'box'),
      ('refrigeration-maintenance', 'Refrigeration Maintenance', 'Refrigeration and cooling maintenance', '#0369A1', 'snowflake'),
      ('store-supplies', 'Store Supplies', 'Store operations and consumables', '#0F766E', 'store'),
      ('building-materials', 'Building Materials', 'Materials used on construction work', '#B45309', 'hammer'),
      ('subcontractors', 'Subcontractors', 'Payments to construction subcontractors', '#4F46E5', 'users'),
      ('equipment-rental', 'Equipment Rental', 'Rental of construction equipment', '#7C3AED', 'forklift'),
      ('permits-inspections', 'Permits and Inspections', 'Permits, inspections, and approvals', '#0369A1', 'clipboard-check'),
      ('jobsite-supplies', 'Jobsite Supplies', 'Jobsite safety and operating supplies', '#15803D', 'hard-hat')
    ON CONFLICT (template_key) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      color = EXCLUDED.color,
      icon = EXCLUDED.icon
  `.execute(database);

  await sql`
    INSERT INTO app.industry_spending_category_templates
      (industry_code, template_key, sort_order)
    VALUES
      ('restaurant', 'food-inventory', 1),
      ('restaurant', 'beverages', 2),
      ('restaurant', 'kitchen-supplies', 3),
      ('restaurant', 'delivery-fees', 4),
      ('restaurant', 'equipment-maintenance', 5),
      ('salon', 'beauty-supplies', 1),
      ('salon', 'linens-laundry', 2),
      ('salon', 'booth-equipment', 3),
      ('salon', 'booking-fees', 4),
      ('salon', 'licensing', 5),
      ('daycare', 'learning-supplies', 1),
      ('daycare', 'meals-snacks', 2),
      ('daycare', 'toys-equipment', 3),
      ('daycare', 'cleaning-safety', 4),
      ('daycare', 'licensing-training', 5),
      ('grocery', 'resale-inventory', 1),
      ('grocery', 'packaging', 2),
      ('grocery', 'refrigeration-maintenance', 3),
      ('grocery', 'delivery-fees', 4),
      ('grocery', 'store-supplies', 5),
      ('construction', 'building-materials', 1),
      ('construction', 'subcontractors', 2),
      ('construction', 'equipment-rental', 3),
      ('construction', 'permits-inspections', 4),
      ('construction', 'jobsite-supplies', 5)
    ON CONFLICT (industry_code, template_key) DO UPDATE SET
      sort_order = EXCLUDED.sort_order
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema
    .dropTable("app.industry_spending_category_templates")
    .ifExists()
    .execute();
  await sql`
    DROP INDEX IF EXISTS app.spending_categories_active_normalized_name_unique
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX spending_categories_active_tenant_name_unique
      ON app.spending_categories (tenant_id, lower(name))
      WHERE status = 'active'
  `.execute(database);
  await sql`
    DELETE FROM app.spending_category_templates
    WHERE template_key IN (
      'food-inventory', 'beverages', 'kitchen-supplies', 'delivery-fees',
      'equipment-maintenance', 'beauty-supplies', 'linens-laundry',
      'booth-equipment', 'booking-fees', 'licensing', 'learning-supplies',
      'meals-snacks', 'toys-equipment', 'cleaning-safety',
      'licensing-training', 'resale-inventory', 'packaging',
      'refrigeration-maintenance', 'store-supplies', 'building-materials',
      'subcontractors', 'equipment-rental', 'permits-inspections',
      'jobsite-supplies'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM app.spending_categories
      WHERE spending_categories.template_key = spending_category_templates.template_key
    )
  `.execute(database);
  await sql`
    INSERT INTO app.spending_category_templates
      (template_key, name, description, color, icon)
    VALUES
      ('advertising', 'Advertising', 'Advertising and promotion', '#7C3AED', 'megaphone'),
      ('car-and-truck', 'Car and Truck', 'Business vehicle costs', '#0F766E', 'car'),
      ('contract-labor', 'Contract Labor', 'Payments to contractors', '#B45309', 'hard-hat'),
      ('insurance', 'Insurance', 'Business insurance costs', '#0369A1', 'shield'),
      ('office-expenses', 'Office Expenses', 'Office operations and services', '#4F46E5', 'building'),
      ('rent-or-lease', 'Rent or Lease', 'Business property and equipment rent', '#BE123C', 'key'),
      ('supplies', 'Supplies', 'Business supplies', '#2563EB', 'package'),
      ('utilities', 'Utilities', 'Business utility costs', '#15803D', 'zap')
    ON CONFLICT (template_key) DO NOTHING
  `.execute(database);
}
