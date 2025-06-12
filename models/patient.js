const mongoose = require("mongoose");

const patientSchema = new mongoose.Schema({
  name: String,
  bloodType: String,
  age: Number,
  hash: String, // Blockchain-logged hash
});

module.exports = mongoose.model("Patient", patientSchema);
