require("dotenv").config();
const bcrypt = require("bcryptjs");
const pool = require("../config/db");

const createAdminUser = async () => {
  try {
    // Ensure SUPER_ADMIN role exists
    await pool.query(
      `INSERT INTO roles (role_name, description) VALUES ('SUPER_ADMIN','Full system access') ON CONFLICT (role_name) DO NOTHING`
    );
    const roleResult = await pool.query(`SELECT id FROM roles WHERE role_name='SUPER_ADMIN'`);
    const roleId = roleResult.rows[0].id;

    const hash = await bcrypt.hash("Admin@123", 12);
    await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role_id, status)
       VALUES ('System Admin', 'admin@accounting.com', $1, $2, 'ACTIVE')
       ON CONFLICT (email) DO NOTHING`,
      [hash, roleId]
    );
    console.log("✅ Admin user created: admin@accounting.com / Admin@123");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
};

createAdminUser();
