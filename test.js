


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
  age: Number
}));

const Organ = mongoose.model("Organ", new mongoose.Schema({
  type: String,
  bloodType: String,
  donorId: String
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
    const savedPatient = await Patient.create(patient); // No hash saved
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
    const savedOrgan = await Organ.create(organ); // No hash saved
    res.status(201).json({ transactionId: txId, hash, organ: savedOrgan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to log organ to Hedera" });
  }
});



async function getHederaHashes(expectedCount = Infinity) {
  const logs = [];
  const query = new TopicMessageQuery()
    .setTopicId(TOPIC_ID)
    .setStartTime(0);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.warn("⚠️ Timeout reached, resolving with partial logs.");
      resolve(logs);
    }, 10000); // Adjust if needed

    query.subscribe(
      client,
      (error) => {
        clearTimeout(timeout);
        console.error("❌ Error during topic subscription:", error);
        reject(error);
      },
      (msg) => {
        const content = Buffer.from(msg.contents).toString("utf8");
        const [type, hash] = content.split("|");

        if (!type || !hash) {
          console.warn("⚠️ Malformed message:", content);
          return;
        }

        logs.push({ type, hash });

        if (logs.length >= expectedCount) {
          clearTimeout(timeout);
          resolve(logs);
        }
      }
    );
  });
}



app.get("/verify", async (req, res) => {
  try {
    const hederaLogs = await getHederaHashes();
    const hederaHashes = new Set(hederaLogs.map(l => l.hash));
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
        valid: hederaHashes.has(computed),
        computedHash: computed
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
        valid: hederaHashes.has(computed),
        computedHash: computed
      });
    }

    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Verification failed" });
  }
});

app.post("/verify", async (req, res) => {
  try {
    const { type, id } = req.body;
    let record, computed;

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

    const hederaLogs = await getHederaHashes();
    const valid = hederaLogs.some(l => l.hash === computed);

    res.json({
      record: type,
      id: record._id,
      valid,
      computedHash: computed
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

// Helper function to parse topic messages
function parseTopicMessage(msg) {
  return {
    timestamp: msg.consensusTimestamp.toDate().toISOString(),
    sequenceNumber: msg.sequenceNumber.toString(),
    message: msg.contents.toString('utf8'),
    runningHash: msg.runningHash.toString('hex'),
    transactionId: msg.initialTransactionId?.toString() || null,
    chunks: msg.chunks?.map(chunk => ({
      contents: chunk.contents.toString('utf8'),
      sequenceNumber: chunk.sequenceNumber.toString(),
      runningHash: chunk.runningHash.toString('hex')
    }))
  };
}

app.get("/logs", async (req, res) => {
  try {
    const messages = [];
    const seenSequenceNumbers = new Set();
    const query = new TopicMessageQuery()
      .setTopicId(TOPIC_ID)
      .setStartTime(0);

    // Enhanced message handling
    const handleMessage = (msg) => {
      const sequenceNumber = msg.sequenceNumber.toString();
      
      if (seenSequenceNumbers.has(sequenceNumber)) {
        console.log(`Skipping duplicate message: ${sequenceNumber}`);
        return;
      }
      
      seenSequenceNumbers.add(sequenceNumber);
      
      try {
        const parsed = parseTopicMessage(msg);
        console.log("Decoded message:", parsed.message);
        messages.push(parsed);
      } catch (parseError) {
        console.error("Error parsing message:", parseError);
      }
    };

    // Subscribe with enhanced error handling
    await new Promise((resolve, reject) => {
      let subscription;
      let timeout;
      
      const cleanup = () => {
        if (subscription) subscription.unsubscribe();
        if (timeout) clearTimeout(timeout);
      };

      // Handle both success and error cases
      const onComplete = () => {
        cleanup();
        resolve();
      };

      const onError = (err) => {
        cleanup();
        reject(err);
      };

      timeout = setTimeout(() => {
        console.log("Subscription timeout reached");
        onComplete();
      }, 10000); // Increased timeout to 10 seconds

      subscription = query.subscribe(
        client,
        (msg) => {
          console.log("Message received in success callback");
          handleMessage(msg);
        },
        (msgOrError) => {
          if (msgOrError?.contents) {
            console.log("Message received in error callback");
            handleMessage(msgOrError);
          } else {
            console.error("Subscription error:", msgOrError);
            onError(msgOrError || new Error("Unknown subscription error"));
          }
        },
        () => {
          console.log("Subscription completed");
          onComplete();
        }
      );
    });

    // Sort messages by sequence number
    messages.sort((a, b) => 
      parseInt(a.sequenceNumber) - parseInt(b.sequenceNumber)
    );

    res.json({
      success: true,
      count: messages.length,
      messages: messages
    });

  } catch (error) {
    console.error("Error in /logs endpoint:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to fetch logs",
      details: error.message 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});



// // server.js
// require("dotenv").config();
// const express = require("express");
// const crypto = require("crypto");
// const mongoose = require("mongoose");
// const {
//   Client,
//   TopicMessageSubmitTransaction,
//   TopicCreateTransaction,
//   TopicMessageQuery
// } = require("@hashgraph/sdk");

// const app = express();
// app.use(express.json());

// // Connect to MongoDB
// mongoose.connect(process.env.MONGODB_URI, {
//   useNewUrlParser: true,
//   useUnifiedTopology: true,
// }).then(() => console.log("MongoDB connected"))
//   .catch((err) => console.error("MongoDB connection error:", err));

// // Models
// const Patient = mongoose.model("Patient", new mongoose.Schema({
//   name: String,
//   bloodType: String,
//   age: Number,
//   hash: String,
// }));

// const Organ = mongoose.model("Organ", new mongoose.Schema({
//   type: String,
//   bloodType: String,
//   donorId: String,
//   hash: String,
// }));

// // Initialize Hedera client
// const client = Client.forTestnet();
// client.setOperator(process.env.HEDERA_ACCOUNT_ID, process.env.HEDERA_PRIVATE_KEY);

// // Topic ID from environment
// const TOPIC_ID = process.env.HEDERA_TOPIC_ID;

// function hashData(data) {
//   return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
// }

// async function submitToHedera(message) {
//   const submitTx = new TopicMessageSubmitTransaction()
//     .setTopicId(TOPIC_ID)
//     .setMessage(message);

//   const submitResponse = await submitTx.execute(client);
//   return submitResponse.transactionId.toString();
// }

// app.post("/patients", async (req, res) => {
//   try {
//     const patient = req.body;
//     const hash = hashData({
//       name: patient.name,
//       bloodType: patient.bloodType,
//       age: patient.age
//     });
//     const message = `PATIENT|${hash}`;
//     const txId = await submitToHedera(message);
//     const savedPatient = await Patient.create({ ...patient, hash });
//     res.status(201).json({ transactionId: txId, hash, patient: savedPatient });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Failed to log patient to Hedera" });
//   }
// });

// app.post("/organs", async (req, res) => {
//   try {
//     const organ = req.body;
//     const hash = hashData({
//       type: organ.type,
//       bloodType: organ.bloodType,
//       donorId: organ.donorId
//     });
//     const message = `ORGAN|${hash}`;
//     const txId = await submitToHedera(message);
//     const savedOrgan = await Organ.create({ ...organ, hash });
//     res.status(201).json({ transactionId: txId, hash, organ: savedOrgan });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Failed to log organ to Hedera" });
//   }
// });

// // Verify all records integrity
// app.get("/verify", async (req, res) => {
//   try {
//     const results = [];

//     const patients = await Patient.find();
//     for (const p of patients) {
//       const computed = hashData({
//         name: p.name,
//         bloodType: p.bloodType,
//         age: p.age
//       });
//       results.push({
//         record: "patient",
//         id: p._id,
//         valid: computed === p.hash,
//         computedHash: computed,
//         storedHash: p.hash,
//       });
//     }

//     const organs = await Organ.find();
//     for (const o of organs) {
//       const computed = hashData({
//         type: o.type,
//         bloodType: o.bloodType,
//         donorId: o.donorId
//       });
//       results.push({
//         record: "organ",
//         id: o._id,
//         valid: computed === o.hash,
//         computedHash: computed,
//         storedHash: o.hash,
//       });
//     }

//     res.json(results);
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Verification failed" });
//   }
// });

// // Verify a specific record by type and ID
// app.post("/verify", async (req, res) => {
//   try {
//     const { type, id } = req.body;
//     let record;
//     let computed;

//     if (type === "patient") {
//       record = await Patient.findById(id);
//       if (!record) return res.status(404).json({ error: "Patient not found" });
//       computed = hashData({
//         name: record.name,
//         bloodType: record.bloodType,
//         age: record.age
//       });
//     } else if (type === "organ") {
//       record = await Organ.findById(id);
//       if (!record) return res.status(404).json({ error: "Organ not found" });
//       computed = hashData({
//         type: record.type,
//         bloodType: record.bloodType,
//         donorId: record.donorId
//       });
//     } else {
//       return res.status(400).json({ error: "Invalid type specified" });
//     }

//     res.json({
//       record: type,
//       id: record._id,
//       valid: computed === record.hash,
//       computedHash: computed,
//       storedHash: record.hash,
//     });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Verification failed" });
//   }
// });

// // Optional: Create new topic if needed
// app.get("/create-topic", async (req, res) => {
//   try {
//     const tx = await new TopicCreateTransaction().execute(client);
//     const receipt = await tx.getReceipt(client);
//     res.json({ topicId: receipt.topicId.toString() });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Failed to create topic" });
//   }
// });

// // Helper function to parse topic messages
// function parseTopicMessage(msg) {
//   return {
//     timestamp: msg.consensusTimestamp.toDate().toISOString(),
//     sequenceNumber: msg.sequenceNumber.toString(),
//     message: msg.contents.toString('utf8'),
//     runningHash: msg.runningHash.toString('hex'),
//     transactionId: msg.initialTransactionId?.toString() || null,
//     chunks: msg.chunks?.map(chunk => ({
//       contents: chunk.contents.toString('utf8'),
//       sequenceNumber: chunk.sequenceNumber.toString(),
//       runningHash: chunk.runningHash.toString('hex')
//     }))
//   };
// }

// app.get("/logs", async (req, res) => {
//   try {
//     const messages = [];
//     const seenSequenceNumbers = new Set();
//     const query = new TopicMessageQuery()
//       .setTopicId(TOPIC_ID)
//       .setStartTime(0);

//     // Enhanced message handling
//     const handleMessage = (msg) => {
//       const sequenceNumber = msg.sequenceNumber.toString();
      
//       if (seenSequenceNumbers.has(sequenceNumber)) {
//         console.log(`Skipping duplicate message: ${sequenceNumber}`);
//         return;
//       }
      
//       seenSequenceNumbers.add(sequenceNumber);
      
//       try {
//         const parsed = parseTopicMessage(msg);
//         console.log("Decoded message:", parsed.message);
//         messages.push(parsed);
//       } catch (parseError) {
//         console.error("Error parsing message:", parseError);
//       }
//     };

//     // Subscribe with enhanced error handling
//     await new Promise((resolve, reject) => {
//       let subscription;
//       let timeout;
      
//       const cleanup = () => {
//         if (subscription) subscription.unsubscribe();
//         if (timeout) clearTimeout(timeout);
//       };

//       // Handle both success and error cases
//       const onComplete = () => {
//         cleanup();
//         resolve();
//       };

//       const onError = (err) => {
//         cleanup();
//         reject(err);
//       };

//       timeout = setTimeout(() => {
//         console.log("Subscription timeout reached");
//         onComplete();
//       }, 10000); // Increased timeout to 10 seconds

//       subscription = query.subscribe(
//         client,
//         (msg) => {
//           console.log("Message received in success callback");
//           handleMessage(msg);
//         },
//         (msgOrError) => {
//           if (msgOrError?.contents) {
//             console.log("Message received in error callback");
//             handleMessage(msgOrError);
//           } else {
//             console.error("Subscription error:", msgOrError);
//             onError(msgOrError || new Error("Unknown subscription error"));
//           }
//         },
//         () => {
//           console.log("Subscription completed");
//           onComplete();
//         }
//       );
//     });

//     // Sort messages by sequence number
//     messages.sort((a, b) => 
//       parseInt(a.sequenceNumber) - parseInt(b.sequenceNumber)
//     );

//     res.json({
//       success: true,
//       count: messages.length,
//       messages: messages
//     });

//   } catch (error) {
//     console.error("Error in /logs endpoint:", error);
//     res.status(500).json({ 
//       success: false,
//       error: "Failed to fetch logs",
//       details: error.message 
//     });
//   }
// });

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//   console.log(`Server running on port ${PORT}`);
// });
