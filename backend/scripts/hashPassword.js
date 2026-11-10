const bcrypt = require("bcrypt");

const plainPassword = process.argv[2];

if (!plainPassword) {
  console.error("Usage: node scripts/hashPassword.js <plain_password>");
  process.exit(1);
}

(async () => {
  try {
    const hash = await bcrypt.hash(plainPassword, 10);
    console.log(hash);
  } catch (error) {
    console.error("Failed to generate password hash:", error.message);
    process.exit(1);
  }
})();
