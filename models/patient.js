const mongoose = require("mongoose");

const Patient = mongoose.model("Patient", new mongoose.Schema({
  name: String,
  bloodType: String,
  age: Number,
  organNeeded: String
}));


module.exports = mongoose.model("Patient", patientSchema);
