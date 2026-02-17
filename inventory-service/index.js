import express from "express";
import { Kafka } from "kafkajs";
import pkg from "pg";

const { Pool } = pkg;

const PORT = process.env.PORT || 4003;
const KAFKA_BROKER = process.env.KAFKA_BROKER;

const pool = new Pool();

const kafka = new Kafka({
    clientId: "inventory-service",
    brokers: [KAFKA_BROKER],
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: "inventory-service-group" });

const app = express();
app.use(express.json());

async function initDb() {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      order_id TEXT PRIMARY KEY,
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
    await consumer.subscribe({ topic: "payment.charged" });

    await consumer.run({
        eachMessage: async ({ message }) => {
            const data = JSON.parse(message.value.toString());
            const orderId = data.orderId;

            const existing = await pool.query(
                `SELECT * FROM reservations WHERE order_id=$1`,
                [orderId]
            );
            if (existing.rows.length > 0) return;

            const fail = Math.random() < 0.35;

            if (fail) {
                await pool.query(
                    `INSERT INTO reservations(order_id, status) VALUES($1, $2)`,
                    [orderId, "FAILED"]
                );

                await pool.query(`INSERT INTO outbox(topic, payload) VALUES($1, $2)`, [
                    "inventory.failed",
                    { orderId },
                ]);

                return;
            }

            await pool.query(
                `INSERT INTO reservations(order_id, status) VALUES($1, $2)`,
                [orderId, "RESERVED"]
            );

            await pool.query(`INSERT INTO outbox(topic, payload) VALUES($1, $2)`, [
                "inventory.reserved",
                { orderId },
            ]);
        },
    });
}

async function main() {
    await initDb();

    await producer.connect();
    startConsumer();

    setInterval(publishOutbox, 1500);

    app.listen(PORT, () => console.log("Inventory Service running on", PORT));
}

main();
