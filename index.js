// server.js
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const {
  Client,
  TopicMessageSubmitTransaction,
  TopicCreateTransaction,
  TopicMessageQuery
} = require("@hashgraph/sdk");

const app = express();
app.use(express.json());

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
    const hash = hashData(patient);
    const message = `PATIENT|${hash}`;
    const txId = await submitToHedera(message);
    res.status(201).json({ transactionId: txId, hash });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to log patient to Hedera" });
  }
});

app.post("/organs", async (req, res) => {
  try {
    const organ = req.body;
    const hash = hashData(organ);
    const message = `ORGAN|${hash}`;
    const txId = await submitToHedera(message);
    res.status(201).json({ transactionId: txId, hash });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to log organ to Hedera" });
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
function parseTopicMessage(msg) {
  const decodedMessage = Buffer.from(msg.contents).toString("utf8");
  const timestampISO = msg.consensusTimestamp.toDate().toISOString();
  return {
    timestamp: timestampISO,
    sequenceNumber: msg.sequenceNumber.toString(),
    message: decodedMessage,
  };
}

// Helper function to convert protobuf timestamp to JS Date string
function protobufTimestampToISOString(consensusTimestamp) {
  // seconds and nanos come as Long objects or numbers
  const seconds = typeof consensusTimestamp.seconds.toNumber === "function"
    ? consensusTimestamp.seconds.toNumber()
    : consensusTimestamp.seconds;
  const nanos = typeof consensusTimestamp.nanos.toNumber === "function"
    ? consensusTimestamp.nanos.toNumber()
    : consensusTimestamp.nanos;

  // Convert to milliseconds
  const ms = seconds * 1000 + Math.floor(nanos / 1e6);

  return new Date(ms).toISOString();
}

function parseTopicMessage(msg) {
  try {
    return {
      timestamp: protobufTimestampToISOString(msg.consensusTimestamp),
      sequenceNumber: msg.sequenceNumber.toString(),
      message: msg.contents.toString("utf8"), // Direct conversion since contents is already a Buffer
      runningHash: msg.runningHash.toString('hex').substring(0, 16) + '...', // First 16 chars for reference
    };
  } catch (error) {
    console.error('Error parsing message:', error);
    return {
      timestamp: 'unknown',
      sequenceNumber: 'unknown',
      message: 'Error parsing message',
      error: error.message
    };
  }
}

app.get("/logs", async (req, res) => {
  try {
    const messages = [];
    const seenSequenceNumbers = new Set(); // To avoid duplicates

    const query = new TopicMessageQuery()
      .setTopicId(TOPIC_ID)
      .setStartTime(0); // or new Date() for recent messages only

    // Subscribe and collect messages for 5 seconds
    await new Promise((resolve, reject) => {
      const subscription = query.subscribe(
        client,
        (msg) => {
          // This might not be called, messages seem to come through error callback
          console.log("Message received in message callback");
          
          const sequenceNumber = msg.sequenceNumber.toString();
          
          if (seenSequenceNumbers.has(sequenceNumber)) {
            console.log(`Skipping duplicate message with sequence number: ${sequenceNumber}`);
            return;
          }
          
          seenSequenceNumbers.add(sequenceNumber);
          
          const parsed = parseTopicMessage(msg);
          console.log("Decoded message:", parsed);
          messages.push(parsed);
        },
        (msgOrError) => {
          // Check if this is actually a TopicMessage (not an error)
          if (msgOrError && msgOrError.consensusTimestamp && msgOrError.contents) {
            console.log("Message received in error callback (treating as message)");
            
            const sequenceNumber = msgOrError.sequenceNumber.toString();
            
            if (seenSequenceNumbers.has(sequenceNumber)) {
              console.log(`Skipping duplicate message with sequence number: ${sequenceNumber}`);
              return;
            }
            
            seenSequenceNumbers.add(sequenceNumber);
            
            const parsed = parseTopicMessage(msgOrError);
            console.log("Decoded message:", parsed);
            messages.push(parsed);
          } else {
            console.error("Actual subscription error:", msgOrError);
          }
        }
      );

      setTimeout(() => {
        subscription.unsubscribe();
        resolve();
      }, 5000);
    });

    // Sort messages by sequence number
    messages.sort((a, b) => parseInt(a.sequenceNumber) - parseInt(b.sequenceNumber));

    res.json({
      success: true,
      count: messages.length,
      messages: messages
    });
  } catch (error) {
    console.error("Error fetching logs:", error);
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
