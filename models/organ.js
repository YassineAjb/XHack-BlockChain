const mongoose = require("mongoose");

const organSchema = new mongoose.Schema({
  type: String,
  bloodType: String,
  donorId: String,
  hash: String,
});

module.exports = mongoose.model("Organ", organSchema);
