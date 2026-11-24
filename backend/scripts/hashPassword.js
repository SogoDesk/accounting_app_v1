
const bcrypt = require("bcryptjs");
const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question("Enter your new password: ", async (password) => {
  try {
    const hash = await bcrypt.hash(password, 10);
    console.log("\nGenerated password hash:\n");
    console.log(hash);
  } catch (error) {
    console.error("Failed:", error.message);
  } finally {
    rl.close();
  }
});
