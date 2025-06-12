// server.js
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const {
  Client,
  TopicMessageSubmitTransaction,
  TopicCreateTransaction,
  TopicMessageQuery
} = require("@hashgraph/sdk");

const app = express();
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Models
const Patient = mongoose.model("Patient", new mongoose.Schema({
  name: String,
  bloodType: String,
  age: Number,
  hash: String,
}));

const Organ = mongoose.model("Organ", new mongoose.Schema({
  type: String,
  bloodType: String,
  donorId: String,
  hash: String,
}));

// Initialize Hedera client
const client = Client.forTestnet();
client.setOperator(process.env.HEDERA_ACCOUNT_ID, process.env.HEDERA_PRIVATE_KEY);

// Topic ID from environment
const TOPIC_ID = process.env.HEDERA_TOPIC_ID;

function hashData(data) {
  return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

async function submitToHedera(message) {
  const submitTx = new TopicMessageSubmitTransaction()
    .setTopicId(TOPIC_ID)
    .setMessage(message);

  const submitResponse = await submitTx.execute(client);
  return submitResponse.transactionId.toString();
}

app.post("/patients", async (req, res) => {
  try {
    const patient = req.body;
    const hash = hashData({
      name: patient.name,
      bloodType: patient.bloodType,
      age: patient.age
    });
    const message = `PATIENT|${hash}`;
    const txId = await submitToHedera(message);
    const savedPatient = await Patient.create({ ...patient, hash });
    res.status(201).json({ transactionId: txId, hash, patient: savedPatient });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to log patient to Hedera" });
  }
});

app.post("/organs", async (req, res) => {
  try {
    const organ = req.body;
    const hash = hashData({
      type: organ.type,
      bloodType: organ.bloodType,
      donorId: organ.donorId
    });
    const message = `ORGAN|${hash}`;
    const txId = await submitToHedera(message);
    const savedOrgan = await Organ.create({ ...organ, hash });
    res.status(201).json({ transactionId: txId, hash, organ: savedOrgan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to log organ to Hedera" });
  }
});

// Verify all records integrity
app.get("/verify", async (req, res) => {
  try {
    const results = [];

    const patients = await Patient.find();
    for (const p of patients) {
      const computed = hashData({
        name: p.name,
        bloodType: p.bloodType,
        age: p.age
      });
      results.push({
        record: "patient",
        id: p._id,
        valid: computed === p.hash,
        computedHash: computed,
        storedHash: p.hash,
      });
    }

    const organs = await Organ.find();
    for (const o of organs) {
      const computed = hashData({
        type: o.type,
        bloodType: o.bloodType,
        donorId: o.donorId
      });
      results.push({
        record: "organ",
        id: o._id,
        valid: computed === o.hash,
        computedHash: computed,
        storedHash: o.hash,
      });
    }

    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// Verify a specific record by type and ID
app.post("/verify", async (req, res) => {
  try {
    const { type, id } = req.body;
    let record;
    let computed;

    if (type === "patient") {
      record = await Patient.findById(id);
      if (!record) return res.status(404).json({ error: "Patient not found" });
      computed = hashData({
        name: record.name,
        bloodType: record.bloodType,
        age: record.age
      });
    } else if (type === "organ") {
      record = await Organ.findById(id);
      if (!record) return res.status(404).json({ error: "Organ not found" });
      computed = hashData({
        type: record.type,
        bloodType: record.bloodType,
        donorId: record.donorId
      });
    } else {
      return res.status(400).json({ error: "Invalid type specified" });
    }

    res.json({
      record: type,
      id: record._id,
      valid: computed === record.hash,
      computedHash: computed,
      storedHash: record.hash,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// Optional: Create new topic if needed
app.get("/create-topic", async (req, res) => {
  try {
    const tx = await new TopicCreateTransaction().execute(client);
    const receipt = await tx.getReceipt(client);
    res.json({ topicId: receipt.topicId.toString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create topic" });
  }
});

// Get logs from the topic
app.get("/logs", async (req, res) => {
  try {
    const messages = [];
    const query = new TopicMessageQuery()
      .setTopicId(TOPIC_ID)
      .setStartTime(0);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), 3000);
      query.subscribe(
        client,
        (msg) => {
          const decoded = Buffer.from(msg.contents).toString("utf8");
          messages.push({
            timestamp: msg.consensusTimestamp.toDate().toISOString(),
            sequenceNumber: msg.sequenceNumber.toString(),
            message: decoded
          });
        },
        (err) => {
          clearTimeout(timeout);
          reject(err);
        },
        () => {
          clearTimeout(timeout);
          resolve();
        }
      );
    });

    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch logs" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


