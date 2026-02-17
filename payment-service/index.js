import express from "express";
import { Kafka } from "kafkajs";
import pkg from "pg";

const { Pool } = pkg;

const PORT = process.env.PORT || 4002;
const KAFKA_BROKER = process.env.KAFKA_BROKER;

const pool = new Pool();

const kafka = new Kafka({
    clientId: "payment-service",
    brokers: [KAFKA_BROKER],
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: "payment-service-group" });

const app = express();
app.use(express.json());

async function initDb() {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      order_id TEXT PRIMARY KEY,
      amount INT NOT NULL,
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

async function startConsumer() {
    await consumer.connect();
    await consumer.subscribe({ topic: "order.created" });

    await consumer.run({
        eachMessage: async ({ message }) => {
            const data = JSON.parse(message.value.toString());

            const orderId = data.orderId;
            const amount = data.totalAmount;

            const existing = await pool.query(
                `SELECT * FROM payments WHERE order_id=$1`,
                [orderId]
            );
            if (existing.rows.length > 0) return;

            const fail = Math.random() < 0.25;

            if (fail) {
                await pool.query(
                    `INSERT INTO payments(order_id, amount, status) VALUES($1, $2, $3)`,
                    [orderId, amount, "FAILED"]
                );

                await pool.query(`INSERT INTO outbox(topic, payload) VALUES($1, $2)`, [
                    "payment.failed",
                    { orderId, amount },
                ]);

                return;
            }

            await pool.query(
                `INSERT INTO payments(order_id, amount, status) VALUES($1, $2, $3)`,
                [orderId, amount, "CHARGED"]
            );

            await pool.query(`INSERT INTO outbox(topic, payload) VALUES($1, $2)`, [
                "payment.charged",
                { orderId, amount },
            ]);
        },
    });
}

async function main() {
    await initDb();

    await producer.connect();
    startConsumer();

    setInterval(publishOutbox, 1500);

    app.listen(PORT, () => console.log("Payment Service running on", PORT));
}

main();
