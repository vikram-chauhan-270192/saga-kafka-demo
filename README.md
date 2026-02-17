# Saga Pattern (Choreography) with Kafka (KRaft) + Postgres + Express.js

This repository is a working demo of the Saga Pattern for distributed transactions using:

- Kafka (KRaft mode, no Zookeeper)
- Postgres (one database per microservice)
- Node.js + Express.js microservices
- Outbox Pattern (polling) for reliable Kafka publishing
- Docker + Docker Compose (local development)

This demo implements Saga Choreography:
- There is no central orchestrator
- Each microservice reacts to Kafka events and emits the next event

---

## 1) What Problem This Solves

In a monolith, you can do:

- Create order
- Charge payment
- Reserve inventory
- Confirm order

inside a single ACID database transaction.

In microservices, each service has its own database, so you cannot use a single distributed ACID transaction.

A Saga solves this by using:

- Local transactions in each service
- Kafka events between services
- Compensating actions (undo steps) when failures happen

---

## 2) Saga Flow Implemented in This Repo

Kafka topics used:

- order.created
- payment.charged
- payment.failed
- inventory.reserved
- inventory.failed

Step-by-step:

1. Order Service
  - HTTP: POST /orders
  - Inserts order row into Postgres (status = PENDING)
  - Writes an outbox event for order.created

2. Payment Service
  - Consumes order.created
  - Simulates payment (random success/failure)
  - Inserts payment row into Postgres
  - Publishes payment.charged OR payment.failed

3. Inventory Service
  - Consumes payment.charged
  - Simulates inventory reservation (random success/failure)
  - Inserts reservation row into Postgres
  - Publishes inventory.reserved OR inventory.failed

4. Order Service
  - Consumes payment + inventory result events
  - Updates order status:
    - payment.failed -> CANCELLED
    - inventory.failed -> CANCELLED
    - inventory.reserved -> CONFIRMED

---

## 3) Important Note About Compensation

This demo implements a simplified Saga:

- If payment fails -> order cancelled
- If inventory fails -> order cancelled

It does NOT refund payment yet.

In a production Saga, you would add:
- inventory.failed triggers payment refund
- payment.refunded topic
- Order service updates final state

---

## 4) Project Structure

The repository structure looks like this:

    saga-kafka-kraft-demo/
    ├── docker-compose.yml
    ├── README.md
    │
    ├── order-service/
    │   ├── Dockerfile
    │   ├── package.json
    │   ├── package-lock.json
    │   └── index.js
    │
    ├── payment-service/
    │   ├── Dockerfile
    │   ├── package.json
    │   ├── package-lock.json
    │   └── index.js
    │
    └── inventory-service/
        ├── Dockerfile
        ├── package.json
        ├── package-lock.json
        └── index.js

---

## 5) Root File: docker-compose.yml

### What it does

The docker-compose.yml file starts:

1. Kafka broker in KRaft mode
2. A Kafka topic initializer container (kafka-init)
3. 3 Postgres databases (one per microservice)
4. 3 Node.js microservices

---

### Kafka in KRaft Mode

Kafka is started using Confluent’s Kafka image:

- confluentinc/cp-kafka:7.5.3

KRaft mode is enabled using:

- KAFKA_PROCESS_ROLES=broker,controller
- KAFKA_CONTROLLER_QUORUM_VOTERS=1@kafka:9093

No Zookeeper container is used.

---

### Why kafka-init exists

Kafka topics must exist before services start.

If Node services start too early, KafkaJS may crash with an error like:

    KafkaJSProtocolError: This server does not host this topic-partition

To avoid this, the project uses kafka-init which:

- waits for Kafka to be healthy
- creates required topics
- exits successfully
- then services start

---

### Postgres per microservice

Each microservice has its own Postgres container:

- Order DB -> localhost:5433
- Payment DB -> localhost:5434
- Inventory DB -> localhost:5435

This enforces the microservice rule:

Each service owns its own database.

---

## 6) order-service/

### 6.1) order-service/Dockerfile

This Dockerfile builds the order-service container.

It does:

- Uses Node 20 Alpine
- Installs dependencies using npm ci
- Copies source code into container
- Runs npm start

---

### 6.2) order-service/package.json

Defines dependencies:

- express -> HTTP API
- kafkajs -> Kafka producer/consumer
- pg -> Postgres client
- uuid -> generate orderId

---

### 6.3) order-service/index.js

This file has 3 responsibilities:

A) HTTP API (Saga Start)

- Endpoint: POST /orders
- Creates an order in Postgres
- Writes an event to the outbox table
- The outbox event is later published to Kafka as order.created

B) Database Tables Created

On startup, the service creates:

1) orders table

Stores:

- order_id (primary key)
- user_id
- total_amount
- status
- created_at

Statuses used in this demo:

- PENDING
- PAID
- CONFIRMED
- CANCELLED

2) outbox table

Stores events that must be published reliably to Kafka.

Fields:

- topic
- payload (JSON)
- published (boolean)

C) Kafka Consumer (Saga Updates)

The order service consumes:

- payment.charged
- payment.failed
- inventory.reserved
- inventory.failed

Then updates the order status.

---

## 7) payment-service/

### 7.1) payment-service/Dockerfile

Same structure as order-service Dockerfile.

---

### 7.2) payment-service/package.json

Dependencies:

- kafkajs
- pg
- express (kept for consistency)

---

### 7.3) payment-service/index.js

The payment service is event-driven.

It has no required HTTP endpoints in this demo.

A) Database tables created

1) payments table

Stores:

- order_id (primary key)
- amount
- status (CHARGED or FAILED)
- created_at

order_id is the primary key to ensure idempotency.

If Kafka delivers the same event again, payment service checks:

- Do we already have a payment row for this orderId?

If yes -> it ignores the duplicate message.

2) outbox table

Same purpose as in other services.

B) Kafka Consumer

Consumes:

- order.created

Then:

- checks idempotency
- simulates random failure
- inserts payment row
- writes outbox event:
  - payment.charged OR payment.failed

C) Outbox Publisher

Every ~1.5 seconds:

- selects unpublished outbox rows
- publishes them to Kafka
- marks them as published

---

## 8) inventory-service/

### 8.1) inventory-service/Dockerfile

Same structure as the other services.

---

### 8.2) inventory-service/package.json

Dependencies:

- kafkajs
- pg
- express

---

### 8.3) inventory-service/index.js

The inventory service is also event-driven.

A) Database tables created

1) reservations table

Stores:

- order_id (primary key)
- status (RESERVED or FAILED)
- created_at

order_id is primary key to ensure idempotency.

2) outbox table

Same purpose as in other services.

B) Kafka Consumer

Consumes:

- payment.charged

Then:

- checks idempotency
- simulates random reservation failure
- inserts reservation row
- writes outbox event:
  - inventory.reserved OR inventory.failed

C) Outbox Publisher

Every ~1.5 seconds:

- selects unpublished outbox rows
- publishes them to Kafka
- marks them as published

---

## 9) Outbox Pattern Explained

Why it is needed:

If you publish directly to Kafka after writing to DB, you can lose events.

Example failure:

1. DB insert succeeds
2. Kafka publish fails (network issue)
3. Downstream services never receive the event
4. Saga becomes inconsistent

So instead, each service:

1. writes business data into DB
2. writes event into outbox table
3. background loop publishes outbox rows to Kafka
4. marks them as published

This ensures reliable delivery.

---

## 10) How to Run

Stop and remove everything (recommended):

    docker compose down -v

Start the full system:

    docker compose up --build

---

## 11) Trigger the Saga

Create an order (starts the Saga):

    curl -X POST http://localhost:4001/orders \
      -H "Content-Type: application/json" \
      -d '{"userId":"u1","totalAmount":500}'

Example response:

    {
      "orderId": "b52d7c62-2c49-4cc5-8d88-1c0b45a5c6b7",
      "status": "PENDING"
    }

---

## 12) Check Postgres Data

Order DB:

    psql -h localhost -p 5433 -U order_user -d order_db

Then run:

    SELECT * FROM orders ORDER BY created_at DESC;
    SELECT * FROM outbox ORDER BY id DESC;

Payment DB:

    psql -h localhost -p 5434 -U payment_user -d payment_db

Then run:

    SELECT * FROM payments ORDER BY created_at DESC;
    SELECT * FROM outbox ORDER BY id DESC;

Inventory DB:

    psql -h localhost -p 5435 -U inventory_user -d inventory_db

Then run:

    SELECT * FROM reservations ORDER BY created_at DESC;
    SELECT * FROM outbox ORDER BY id DESC;

---

## 13) Common Issues

### Issue: KafkaJSProtocolError: This server does not host this topic-partition

This happens when services start before Kafka topics exist.

Fix used in this repo:

- kafka-init creates topics before services start
- Kafka auto topic creation is disabled

---

### Issue: KafkaJS partitioner warning

KafkaJS may print:

KafkaJS v2.0.0 switched default partitioner...

This is only a warning.

To silence it, set this env var in docker-compose:

- KAFKAJS_NO_PARTITIONER_WARNING=1

---

## 14) Production Improvements (Recommended)

This demo is intentionally minimal.

For production you should add:

- Proper compensation (refund flow)
- Retry topics and DLQ
- Outbox locking (for multiple replicas)
- DB migrations
- OpenTelemetry tracing
- Schema Registry (Avro/Protobuf)

---

## 15) Summary

This repo demonstrates:

- Saga Pattern (Choreography)
- Kafka in KRaft mode
- Postgres per microservice
- Outbox pattern for reliable event publishing
- Docker Compose local environment
