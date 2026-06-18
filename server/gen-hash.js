// Generate a scrypt password hash for LOGIN_PASS_HASH.
// Usage: node gen-hash.js 'your-strong-password'
const crypto = require("crypto");
const pass = process.argv[2];
if (!pass) {
  console.error("usage: node gen-hash.js '<password>'");
  process.exit(1);
}
const salt = crypto.randomBytes(16);
const dk = crypto.scryptSync(pass, salt, 32);
console.log(salt.toString("hex") + ":" + dk.toString("hex"));
