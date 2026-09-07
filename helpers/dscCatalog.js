export const DSC_COMPANY_SEED = [
  { value: "emudhra", name: "eMudhra" },
  { value: "capricorn", name: "Capricorn" },
  { value: "vsign", name: "VSign (Verasys)" },
  { value: "ncode", name: "nCode Solutions" },
  { value: "safescrypt", name: "SafeScrypt (Sify)" },
  { value: "pantasign", name: "PantaSign" },
  { value: "idsign", name: "IDSign" },
  { value: "xtratrust", name: "XtraTrust" },
  { value: "prodigisign", name: "ProDigiSign" },
  { value: "signx", name: "SignX" },
  { value: "care4sign", name: "Care4Sign" },
  { value: "risl", name: "RISL (RajComp)" },
  { value: "cdac", name: "C-DAC" },
  { value: "protean", name: "Protean (NSDL e-Gov)" },
];

export const DSC_TYPE_SEED = [
  { value: "class_2_dsc", name: "Class 2 DSC" },
  { value: "class_3_dsc", name: "Class 3 DSC" },
  { value: "signing_certificate", name: "Signing Certificate" },
  { value: "encryption_certificate", name: "Encryption Certificate" },
  { value: "signing_encryption_dsc", name: "Signing + Encryption DSC" },
];

let catalogReady = false;

export async function ensureDscCatalog(pool) {
  if (catalogReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dsc_companies (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      company_id VARCHAR(40) NOT NULL,
      name VARCHAR(160) NOT NULL,
      slug VARCHAR(80) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
      create_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      modify_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_dsc_companies_id (company_id),
      UNIQUE KEY uq_dsc_companies_slug (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dsc_types (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      type_id VARCHAR(40) NOT NULL,
      name VARCHAR(160) NOT NULL,
      slug VARCHAR(80) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
      create_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      modify_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_dsc_types_id (type_id),
      UNIQUE KEY uq_dsc_types_slug (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  for (let i = 0; i < DSC_COMPANY_SEED.length; i += 1) {
    const row = DSC_COMPANY_SEED[i];
    await pool.query(
      `INSERT INTO dsc_companies (company_id, name, slug, sort_order, status)
       VALUES (?, ?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE name = VALUES(name), sort_order = VALUES(sort_order), status = 'active'`,
      [`dscco_${row.value}`, row.name, row.value, i + 1],
    );
  }

  for (let i = 0; i < DSC_TYPE_SEED.length; i += 1) {
    const row = DSC_TYPE_SEED[i];
    await pool.query(
      `INSERT INTO dsc_types (type_id, name, slug, sort_order, status)
       VALUES (?, ?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE name = VALUES(name), sort_order = VALUES(sort_order), status = 'active'`,
      [`dsctp_${row.value}`, row.name, row.value, i + 1],
    );
  }

  catalogReady = true;
}

export async function listDscCompanies(pool) {
  await ensureDscCatalog(pool);
  const [rows] = await pool.query(
    `SELECT name, slug AS value
     FROM dsc_companies
     WHERE status = 'active'
     ORDER BY sort_order ASC, name ASC`,
  );
  return rows;
}

export async function listDscTypes(pool) {
  await ensureDscCatalog(pool);
  const [rows] = await pool.query(
    `SELECT name, slug AS value
     FROM dsc_types
     WHERE status = 'active'
     ORDER BY sort_order ASC, name ASC`,
  );
  return rows;
}
