const crypto = require("crypto");
const mongoose = require("mongoose");

const CURRENT_PASSWORD_ITERATIONS = 210000;
const LEGACY_PASSWORD_ITERATIONS = 1000;

const userSchema = new mongoose.Schema(
  {
    googleId: { type: String, unique: true, sparse: true, index: true },
    email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: String,
    salt: String,
    passwordIterations: { type: Number, default: LEGACY_PASSWORD_ITERATIONS },
    clinic: { type: String, default: "CuraClinic AI" },
    avatar: String,
    role: { type: String, enum: ["DOCTOR", "ADMIN"], default: "DOCTOR" },
    lastLoginAt: Date,
  },
  { timestamps: true }
);

userSchema.methods.setPassword = function (password) {
  this.salt = crypto.randomBytes(16).toString("hex");
  this.passwordIterations = CURRENT_PASSWORD_ITERATIONS;
  this.passwordHash = crypto.pbkdf2Sync(password, this.salt, this.passwordIterations, 64, "sha512").toString("hex");
};

userSchema.methods.validatePassword = function (password) {
  if (!this.passwordHash || !this.salt) return false;
  const iterations = Number(this.passwordIterations) || LEGACY_PASSWORD_ITERATIONS;
  const expected = Buffer.from(this.passwordHash, "hex");
  const actual = crypto.pbkdf2Sync(password, this.salt, iterations, 64, "sha512");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};

userSchema.methods.needsPasswordUpgrade = function () {
  return Boolean(this.passwordHash && this.salt && (Number(this.passwordIterations) || LEGACY_PASSWORD_ITERATIONS) < CURRENT_PASSWORD_ITERATIONS);
};

module.exports = mongoose.models.User || mongoose.model("User", userSchema);
