# Saga Pattern (Choreography) with Kafka (KRaft) + Postgres + Express.js

This repository is a working demo of the **Saga Pattern for distributed transactions** using:

- **Kafka (KRaft mode)** → event bus (no Zookeeper)
- **Postgres** → database per microservice
- **Node.js + Express.js** → microservices
- **Outbox Pattern (polling)** → reliable event publishing

It demonstrates **Saga Choreography** (event-driven), meaning:
- There is **no central orchestrator**
- Each microservice reacts to events and emits the next event

---

## ✅ What Problem This Solves

In microservices, each service has its own database.

So you cannot do a single ACID transaction like:

- Create Order
- Charge Payment
- Reserve Inventory
- Confirm Order

Because each step touches a different database.

Instead, we use a **Saga**:

> A Saga is a sequence of local transactions.  
> If a step fails, the system uses **compensating actions** (undo operations) to reach a consistent final state.

This demo shows the Saga flow using Kafka events.

---

## 🧠 Saga Flow Implemented in This Repo

### Topics Used

- `order.created`
- `payment.charged`
- `payment.failed`
- `inventory.reserved`
- `inventory.failed`

---

### Step-by-step

#### 1) Order Service (HTTP API)
- Receives `POST /orders`
- Creates an order row in Postgres (status = `PENDING`)
- Publishes `order.created`

#### 2) Payment Service (Kafka consumer)
- Consumes `order.created`
- Attempts to charge payment (simulated)
- Writes payment row in Postgres
- Publishes:
    - `payment.charged` OR `payment.failed`

#### 3) Inventory Service (Kafka consumer)
- Consumes `payment.charged`
- Attempts to reserve inventory (simulated)
- Writes reservation row in Postgres
- Publishes:
    - `inventory.reserved` OR `inventory.failed`

#### 4) Order Service (Kafka consumer)
Consumes all saga result events:
- `payment.failed` → Order becomes `CANCELLED`
- `inventory.failed` → Order becomes `CANCELLED`
- `inventory.reserved` → Order becomes `CONFIRMED`

---

## ⚠️ Important Note About Compensation

This demo shows a simplified compensation:

- If inventory fails, order is cancelled.

It does **not** refund payment yet.

In a real production Saga, you would add:

- `inventory.failed` → triggers payment refund
- `payment.refunded` topic
- Order service updates final state accordingly

---

---

# 📁 Project Structure

