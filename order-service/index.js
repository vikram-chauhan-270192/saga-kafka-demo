import express from "express";
import { Kafka } from "kafkajs";
import pkg from "pg";
import { v4 as uuidv4 } from "uuid";

const { Pool } = pkg;

const PORT = process.env.PORT || 4001;
const KAFKA_BROKER = process.env.KAFKA_BROKER;

const pool = new Pool();

const kafka = new Kafka({
    clientId: "order-service",
    brokers: [KAFKA_BROKER],
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: "order-service-group" });

const app = express();
app.use(express.json());

async function initDb() {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      total_amount INT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

    await pool.query(`
    CREATE TABLE IF NOT EXISTS outbox (
      id SERIAL PRIMARY KEY,
      topic TEXT NOT NULL,
      payload JSONB NOT NULL,
      published BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function publishOutbox() {
    const res = await pool.query(`
    SELECT id, topic, payload
    FROM outbox
    WHERE published = FALSE
    ORDER BY id ASC
    LIMIT 50
  `);

    for (const row of res.rows) {
        await producer.send({
            topic: row.topic,
            messages: [{ value: JSON.stringify(row.payload) }],
        });

        await pool.query(`UPDATE outbox SET published = TRUE WHERE id = $1`, [
            row.id,
        ]);
    }
}

app.post("/orders", async (req, res) => {
    const { userId, totalAmount } = req.body;
    const orderId = uuidv4();

    await pool.query(
        `INSERT INTO orders(order_id, user_id, total_amount, status)
     VALUES($1, $2, $3, $4)`,
        [orderId, userId, totalAmount, "PENDING"]
    );

    await pool.query(`INSERT INTO outbox(topic, payload) VALUES($1, $2)`, [
        "order.created",
        { orderId, userId, totalAmount, createdAt: new Date().toISOString() },
    ]);

    res.status(201).json({ orderId, status: "PENDING" });
});

async function startConsumer() {
    await consumer.connect();
    await consumer.subscribe({ topic: "payment.charged" });
    await consumer.subscribe({ topic: "payment.failed" });
    await consumer.subscribe({ topic: "inventory.reserved" });
    await consumer.subscribe({ topic: "inventory.failed" });

    await consumer.run({
        eachMessage: async ({ topic, message }) => {
            const data = JSON.parse(message.value.toString());

            if (topic === "payment.charged") {
                await pool.query(`UPDATE orders SET status='PAID' WHERE order_id=$1`, [
                    data.orderId,
                ]);
            }

            if (topic === "payment.failed") {
                await pool.query(
                    `UPDATE orders SET status='CANCELLED' WHERE order_id=$1`,
                    [data.orderId]
                );
            }

            if (topic === "inventory.reserved") {
                await pool.query(
                    `UPDATE orders SET status='CONFIRMED' WHERE order_id=$1`,
                    [data.orderId]
                );
            }

            if (topic === "inventory.failed") {
                await pool.query(
                    `UPDATE orders SET status='CANCELLED' WHERE order_id=$1`,
                    [data.orderId]
                );
            }
        },
    });
}

async function main() {
    await initDb();

    await producer.connect();
    startConsumer();

    setInterval(publishOutbox, 1500);

    app.listen(PORT, () => console.log("Order Service running on", PORT));
}

main();
