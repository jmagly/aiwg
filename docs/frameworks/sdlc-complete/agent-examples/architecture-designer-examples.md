# Architecture Designer — Worked Examples

Externalized from the agent definition per the few-shot-examples rule (#1587).

## Usage Examples

### E-Commerce Platform

Design architecture for an e-commerce platform:

- Expected: 100K daily active users
- Features: Product catalog, cart, checkout, payments
- Requirements: PCI compliance, 99.9% uptime
- Integrations: Payment gateways, shipping providers
- Budget: Cloud-native, cost-optimized

### Real-Time Analytics System

Design architecture for real-time analytics:

- Data volume: 1M events/second
- Processing: Stream processing with ML inference
- Storage: 90-day hot data, 2-year cold storage
- Query requirements: Sub-second dashboard updates
- Compliance: GDPR data handling

### Microservices Migration

Design migration from monolith to microservices:

- Current: Django monolith with PostgreSQL
- Target: Containerized microservices
- Constraints: Zero downtime migration
- Timeline: 6-month gradual migration
- Team: 10 developers, mixed experience

## Architecture Patterns

### Microservices Architecture

```mermaid
graph TB
    Gateway[API Gateway]
    Auth[Auth Service]
    User[User Service]
    Product[Product Service]
    Order[Order Service]
    Payment[Payment Service]

    Gateway --> Auth
    Gateway --> User
    Gateway --> Product
    Gateway --> Order
    Order --> Payment
    Order --> Product
```

### Event-Driven Architecture

```mermaid
graph LR
    Producer[Event Producers]
    Broker[Message Broker]
    Consumer1[Service A]
    Consumer2[Service B]
    Consumer3[Service C]

    Producer --> Broker
    Broker --> Consumer1
    Broker --> Consumer2
    Broker --> Consumer3
```

### Layered Architecture

```text
┌─────────────────────────┐
│   Presentation Layer    │
├─────────────────────────┤
│   Application Layer     │
├─────────────────────────┤
│    Business Logic       │
├─────────────────────────┤
│    Data Access Layer    │
├─────────────────────────┤
│      Database           │
└─────────────────────────┘
```

## Deployment Sample: Container Orchestration

```yaml
# Kubernetes deployment example
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-deployment
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      containers:
      - name: app
        image: myapp:latest
        ports:
        - containerPort: 8080
```

## ADR Template Sample

```markdown
# ADR-001: [Decision Title]

## Status
Accepted/Rejected/Deprecated

## Context
[What is the issue we're addressing?]

## Decision
[What are we doing?]

## Consequences
[What are the trade-offs?]

## Alternatives Considered
[What other options were evaluated?]
```

## Few-Shot Examples

### Example 1: Simple - Authentication Service Component Design

**Input:**
Design the authentication service component for our healthcare portal application. We need to support healthcare providers logging in with their NPI numbers and passwords, with multi-factor authentication required for compliance. The service should integrate with our existing LDAP directory for provider verification.

**Output:**
```markdown
## Component: Authentication Service

### Overview
Standalone authentication service handling provider credential verification, session management, and MFA enforcement for HIPAA-compliant healthcare portal access.

### Technology Stack
- **Runtime**: Node.js 20.x (LTS)
- **Framework**: Express.js with helmet security middleware
- **Authentication**: Passport.js with custom NPI strategy
- **MFA**: Speakeasy (TOTP) + Twilio (SMS backup)
- **Session Store**: Redis 7.x
- **Directory Integration**: ldapjs for LDAP connectivity

### Component Responsibilities
1. Validate NPI number format and existence
2. Authenticate against LDAP directory
3. Enforce MFA challenge/response
4. Issue JWT access tokens (15min) and refresh tokens (7 days)
5. Maintain active session registry in Redis
6. Audit all authentication attempts

### API Endpoints
- `POST /auth/login` - Initial credential submission
- `POST /auth/mfa/verify` - MFA code verification
- `POST /auth/refresh` - Token refresh
- `POST /auth/logout` - Session termination
- `GET /auth/session` - Session validation

### Data Flow
```
Provider → [NPI + Password] → Auth Service → LDAP Validation
                                    ↓
                              [MFA Challenge]
                                    ↓
                            Provider → [MFA Code]
                                    ↓
                        [JWT Token + Session] → Redis
```

### Security Measures
- Bcrypt password hashing (cost factor 12)
- Rate limiting: 5 attempts per NPI per 15 minutes
- Account lockout after 5 failed attempts
- TOTP window: 1 step (30 seconds)
- Session invalidation on password change
- Comprehensive audit logging to SIEM

### Sequence Diagram
```mermaid
sequenceDiagram
    participant P as Provider
    participant A as Auth Service
    participant L as LDAP
    participant R as Redis
    participant M as MFA Service

    P->>A: POST /auth/login (NPI, password)
    A->>L: Validate NPI + password
    L-->>A: Valid
    A->>M: Generate MFA challenge
    M->>P: Send TOTP/SMS code
    P->>A: POST /auth/mfa/verify (code)
    A->>M: Verify code
    M-->>A: Valid
    A->>R: Create session
    A-->>P: JWT token + refresh token
```

### Non-Functional Requirements
- Response time: < 500ms (95th percentile)
- Availability: 99.9% uptime
- Concurrent sessions: Support 10,000 active providers
- HIPAA audit logging: All authentication events with timestamps
```

**Why This Is Good:**
- Uses domain-specific terminology (NPI, HIPAA, healthcare providers) showing real-world context
- Provides complete technology stack with specific versions
- Includes concrete security measures (bcrypt cost factor, rate limits, lockout policy)
- Sequence diagram visualizes the MFA flow clearly
- NFRs are quantified (< 500ms, 99.9% uptime, 10K concurrent users)

### Example 2: Moderate - ADR for Caching Strategy

**Input:**
We need to decide on a caching strategy for our e-commerce product catalog. We have 500K products with frequent price updates, high read traffic (10K requests/second peak), and need to show real-time inventory. Options are Redis for centralized caching, in-memory application caching, or CDN for static content. Document this decision with trade-offs.

**Output:**
```markdown
# ADR-003: Product Catalog Caching Strategy

## Status
Accepted

## Context
E-commerce platform experiencing high load on product catalog queries (10K req/s peak) with 500K products. Current direct database queries causing:
- Database CPU at 85% during peak hours
- P95 response time degraded to 2.3 seconds
- Price updates require immediate propagation to storefront
- Inventory must reflect within 5 seconds of change

## Decision Matrix

| Criterion (Weight) | Redis Cluster (35%) | In-Memory Cache (25%) | CDN + Edge Cache (40%) |
|-------------------|---------------------|----------------------|------------------------|
| **Read Performance** (30%) | 5 (sub-ms, 100K ops/s) | 4 (fast, memory limited) | 5 (edge latency < 50ms) |
| **Write Latency** (25%) | 4 (pub/sub invalidation) | 3 (requires app restarts) | 2 (TTL-based, stale risk) |
| **Scalability** (20%) | 5 (horizontal sharding) | 2 (vertical only) | 5 (global distribution) |
| **Consistency** (15%) | 5 (immediate propagation) | 3 (eventual consistency) | 2 (TTL-dependent) |
| **Cost** (10%) | 3 ($800/mo cluster) | 5 (no additional cost) | 3 ($600/mo CDN) |
| **Weighted Score** | **4.35** | **3.30** | **3.80** |

## Decision
Implement **hybrid approach**:
1. **CDN (CloudFront)** for static product images and descriptions (24h TTL)
2. **Redis Cluster** for dynamic data (prices, inventory) with pub/sub invalidation
3. **In-memory** (Node.js) for session data and user-specific caching

### Architecture
```mermaid
graph TB
    Client[Client Browser]
    CDN[CloudFront CDN]
    LB[Load Balancer]
    API1[API Server 1]
    API2[API Server 2]
    Redis[(Redis Cluster)]
    DB[(PostgreSQL)]

    Client -->|Static content| CDN
    Client -->|API requests| LB
    LB --> API1
    LB --> API2
    API1 --> Redis
    API2 --> Redis
    Redis -->|Cache miss| DB
    API1 -.->|Pub/sub| Redis
    API2 -.->|Pub/sub| Redis
```

## Consequences

### Positive
- **Performance**: 95% cache hit rate reduces database load to 500 req/s
- **Scalability**: Redis cluster handles 100K ops/s, supports horizontal scaling
- **Consistency**: Pub/sub ensures price updates propagate within 200ms
- **Cost efficiency**: Hybrid approach reduces CDN costs by 60% vs full CDN caching
- **Resilience**: Redis cluster with failover, fallback to database on cache failure

### Negative
- **Complexity**: Three-tier caching requires careful invalidation strategy
- **Operational overhead**: Redis cluster monitoring and maintenance
- **Memory cost**: Redis cluster requires 64GB RAM ($800/month)
- **Cold start**: Cache warmup takes 5 minutes after deployment
- **Eventual consistency**: CDN cached content may be stale up to TTL

### Mitigations
- Cache warmup script runs automatically on deployment
- Monitoring alerts on cache hit rate < 85%
- Automatic failover to database if Redis unavailable
- Gradual rollout with feature flag to validate before full traffic

## Alternatives Considered

### Option A: In-Memory Only (REJECTED)
**Pros**: No additional infrastructure, zero latency
**Cons**: Limited by application memory, no sharing across instances, requires app restart for updates
**Why Rejected**: Cannot scale beyond 100K products in memory, inconsistency across replicas

### Option B: CDN Only (REJECTED)
**Pros**: Global distribution, minimal infrastructure
**Cons**: TTL-based invalidation causes stale data, poor for frequently changing prices
**Why Rejected**: Price update propagation unacceptable (up to 1 hour with TTL)

## Implementation Plan

### Phase 1: Redis Setup (Week 1-2)
- Provision Redis cluster (3 nodes, 64GB each)
- Configure pub/sub channels for price/inventory updates
- Implement cache invalidation logic in API

### Phase 2: CDN Integration (Week 3-4)
- Configure CloudFront distribution
- Update image URLs to CDN endpoints
- Set TTL policies (24h for images, 1h for descriptions)

### Phase 3: Monitoring (Week 5)
- Deploy Grafana dashboards (cache hit rate, latency, memory usage)
- Configure alerts (hit rate < 85%, Redis memory > 80%)
- Load testing to validate 10K req/s target

## Success Metrics
- Cache hit rate: > 95% (currently 0%)
- P95 API latency: < 100ms (currently 2.3s)
- Database load: < 1000 req/s (currently 8000 req/s)
- Price update propagation: < 500ms (currently 30s)
```

**Why This Is Good:**
- Uses Tree-of-Thoughts decision matrix with weighted criteria showing systematic evaluation
- Provides specific quantitative metrics throughout (10K req/s, 95% cache hit, < 100ms latency)
- Documents both chosen approach AND rejected alternatives with clear rationale
- Includes implementation timeline showing phased approach reduces risk
- Trade-offs are explicit with both positive and negative consequences listed

### Example 3: Complex - Event-Driven Microservices Integration Design

**Input:**
Design an event-driven architecture for our order fulfillment system that integrates inventory, warehouse, shipping, and notification services. We need to handle order placement, inventory reservation, picking/packing workflow, shipping label generation, and customer notifications. The system must be resilient to service failures, support idempotency, and provide eventual consistency across services. We expect 5000 orders per hour during peak periods.

**Output:**
```markdown
## Event-Driven Order Fulfillment Architecture

### Overview
Event-driven microservices architecture using Kafka as the event backbone, enabling asynchronous order processing across inventory, warehouse, shipping, and notification services with guaranteed message delivery and idempotent processing.

### System Components

1. **Order Service** - Receives order placement, publishes `OrderCreated` events
2. **Inventory Service** - Manages stock levels, publishes `InventoryReserved` events
3. **Warehouse Service** - Handles pick/pack workflow, publishes `OrderPacked` events
4. **Shipping Service** - Generates labels, tracks shipments, publishes `ShipmentCreated` events
5. **Notification Service** - Sends customer emails/SMS for all order state changes
6. **Saga Orchestrator** - Coordinates distributed transaction across services
7. **Kafka Cluster** - Event bus (3 brokers, replication factor 3)

### Event Flow Architecture

```mermaid
graph TB
    Order[Order Service]
    Inventory[Inventory Service]
    Warehouse[Warehouse Service]
    Shipping[Shipping Service]
    Notify[Notification Service]
    Saga[Saga Orchestrator]
    Kafka[(Kafka Event Bus)]

    Order -->|OrderCreated| Kafka
    Kafka -->|OrderCreated| Inventory
    Kafka -->|OrderCreated| Saga
    Kafka -->|OrderCreated| Notify

    Inventory -->|InventoryReserved| Kafka
    Kafka -->|InventoryReserved| Warehouse
    Kafka -->|InventoryReserved| Saga
    Kafka -->|InventoryReserved| Notify

    Warehouse -->|OrderPacked| Kafka
    Kafka -->|OrderPacked| Shipping
    Kafka -->|OrderPacked| Saga
    Kafka -->|OrderPacked| Notify

    Shipping -->|ShipmentCreated| Kafka
    Kafka -->|ShipmentCreated| Saga
    Kafka -->|ShipmentCreated| Notify

    Saga -.->|Compensate| Kafka
```

### Event Schema

```yaml
# OrderCreated Event
topic: orders.created
key: order_id (for partitioning)
schema:
  event_id: uuid (idempotency key)
  event_timestamp: datetime
  order_id: uuid
  customer_id: uuid
  line_items:
    - sku: string
      quantity: integer
      price: decimal
  shipping_address: object
  payment_status: confirmed

# InventoryReserved Event
topic: inventory.reserved
key: order_id
schema:
  event_id: uuid
  event_timestamp: datetime
  order_id: uuid
  reservation_id: uuid
  reserved_items:
    - sku: string
      quantity: integer
      warehouse_location: string

# OrderPacked Event
topic: warehouse.packed
key: order_id
schema:
  event_id: uuid
  event_timestamp: datetime
  order_id: uuid
  package_weight: decimal
  package_dimensions: object
  packed_at: datetime
  picker_id: string

# ShipmentCreated Event
topic: shipping.created
key: order_id
schema:
  event_id: uuid
  event_timestamp: datetime
  order_id: uuid
  tracking_number: string
  carrier: string
  estimated_delivery: datetime
  label_url: string
```

### Kafka Topic Configuration

| Topic | Partitions | Replication | Retention | Purpose |
|-------|-----------|-------------|-----------|---------|
| `orders.created` | 10 | 3 | 7 days | Order placement events |
| `inventory.reserved` | 10 | 3 | 7 days | Inventory reservation confirmations |
| `warehouse.packed` | 10 | 3 | 7 days | Package ready events |
| `shipping.created` | 10 | 3 | 7 days | Shipment tracking created |
| `saga.compensate` | 5 | 3 | 30 days | Rollback/compensation events |
| `notifications.outbox` | 5 | 3 | 3 days | Notification delivery queue |

### Idempotency Strategy

**Problem:** Network retries can cause duplicate event processing, leading to double inventory reservations or duplicate shipments.

**Solution:** Idempotency tracking using `event_id` as deduplication key.

```typescript
// Idempotent Event Handler Pattern
async function handleInventoryReservation(event: InventoryReserveEvent) {
  const { event_id, order_id, items } = event;

  // Check if already processed
  const processed = await redis.get(`processed:${event_id}`);
  if (processed) {
    console.log(`Event ${event_id} already processed, skipping`);
    return; // Idempotent - no action taken
  }

  try {
    // Begin database transaction
    await db.transaction(async (tx) => {
      // Reserve inventory
      for (const item of items) {
        await tx.inventory.decrement(item.sku, item.quantity);
      }

      // Create reservation record
      await tx.reservations.create({
        reservation_id: uuid(),
        order_id,
        items,
        status: 'reserved'
      });

      // Mark event as processed (in same transaction)
      await tx.processed_events.create({ event_id, processed_at: new Date() });
    });

    // Cache in Redis for fast duplicate detection (7 day TTL)
    await redis.setex(`processed:${event_id}`, 604800, 'true');

    // Publish success event
    await kafka.publish('inventory.reserved', {
      event_id: uuid(),
      order_id,
      reservation_id,
      items
    });

  } catch (error) {
    // Failure - will retry with same event_id (idempotent)
    console.error(`Reservation failed for ${order_id}:`, error);
    throw error; // Kafka will redeliver
  }
}
```

### Failure Handling & Compensating Transactions

**Saga Pattern:** Orchestrated saga manages distributed transaction lifecycle.

#### Happy Path Flow
```
OrderCreated → InventoryReserved → OrderPacked → ShipmentCreated → Complete
```

#### Failure Scenarios

**Scenario 1: Inventory Unavailable**
```
OrderCreated → Inventory Check FAILED
↓
Saga publishes: CompensateOrder
↓
Order Service: Cancel order, refund payment
Notification Service: Send "out of stock" email
```

**Scenario 2: Shipping Label Generation Failed**
```
OrderCreated → InventoryReserved → OrderPacked → Shipping FAILED
↓
Saga publishes: CompensateInventory, CompensateWarehouse
↓
Inventory Service: Release reservation
Warehouse Service: Return items to shelf
Order Service: Mark as "pending retry"
Notification Service: Send "delay" notification
```

**Scenario 3: Service Unavailable**
```
Event published → Kafka stores event (durable)
↓
Service offline (maintenance/crash)
↓
Kafka retains event for 7 days
↓
Service comes back online → Processes backlog
```

### Resilience Patterns

1. **Retry with Exponential Backoff**
   - Initial retry: 1 second
   - Max retry: 5 minutes
   - Max attempts: 10
   - After 10 failures → move to dead letter queue

2. **Dead Letter Queue (DLQ)**
   - Topic: `{original-topic}.dlq`
   - Manual review required for DLQ events
   - Alert on DLQ message count > 10

3. **Circuit Breaker**
   - Open circuit after 5 consecutive failures
   - Half-open after 30 seconds (test request)
   - Close circuit after 3 successful requests

4. **Bulkhead Isolation**
   - Each service has dedicated consumer group
   - Independent failure domains
   - One service failure doesn't block others

### Consistency Model

**Eventual Consistency**: System progresses through states asynchronously, converging to consistent state.

**Consistency Guarantees:**
- **Per-Order Ordering**: Events for same `order_id` processed in sequence (Kafka partition key = order_id)
- **At-Least-Once Delivery**: Kafka guarantees message delivery (with idempotent processing)
- **Eventual State Convergence**: All services eventually reflect same order state (within 5 seconds under normal conditions)

**State Reconciliation:**
- Periodic reconciliation job (every 15 minutes) checks for inconsistencies
- Compares Order Service state vs Inventory/Warehouse/Shipping state
- Auto-corrects minor drifts, flags major inconsistencies for manual review

### Technology Stack

| Component | Technology | Version | Rationale |
|-----------|-----------|---------|-----------|
| Event Bus | Apache Kafka | 3.6 | High throughput (1M+ events/sec), durable storage, partition-based ordering |
| Schema Registry | Confluent Schema Registry | 7.5 | Schema evolution, compatibility checks |
| Orchestrator | Temporal | 1.22 | Saga workflow orchestration, built-in retry/compensation |
| Services Runtime | Node.js | 20.x LTS | Non-blocking I/O for high concurrency |
| Event Sourcing | PostgreSQL + Debezium | 15.4 / 2.4 | Change data capture to Kafka, audit trail |
| Idempotency Cache | Redis | 7.2 | Fast duplicate detection, 7-day TTL |
| Monitoring | Prometheus + Grafana | 2.47 / 10.2 | Kafka lag monitoring, service health |

### Performance Characteristics

| Metric | Target | Peak Capacity |
|--------|--------|---------------|
| Order throughput | 5000 orders/hour (steady) | 10000 orders/hour (burst) |
| End-to-end latency (P95) | < 5 seconds | < 10 seconds |
| Kafka event throughput | 15000 events/sec | 50000 events/sec |
| Event processing lag | < 1 second (P95) | < 5 seconds (P99) |
| Idempotency check | < 10ms (Redis) | N/A |
| Service availability | 99.9% uptime | N/A |

### Deployment Architecture

```yaml
# Kubernetes deployment (simplified)
services:
  kafka:
    replicas: 3
    resources:
      cpu: 4 cores
      memory: 8GB
    storage: 1TB SSD (per broker)

  order-service:
    replicas: 5
    resources:
      cpu: 2 cores
      memory: 4GB

  inventory-service:
    replicas: 5
    resources:
      cpu: 2 cores
      memory: 4GB

  warehouse-service:
    replicas: 3
    resources:
      cpu: 1 core
      memory: 2GB

  shipping-service:
    replicas: 3
    resources:
      cpu: 1 core
      memory: 2GB

  notification-service:
    replicas: 5
    resources:
      cpu: 1 core
      memory: 2GB

  saga-orchestrator:
    replicas: 2
    resources:
      cpu: 2 cores
      memory: 4GB
```

### Monitoring & Observability

**Key Metrics:**
- Kafka consumer lag (alert if > 1000 messages)
- Event processing duration (P50, P95, P99)
- Saga completion rate (target > 99%)
- Compensation event rate (alert if > 1%)
- Dead letter queue depth (alert if > 10)

**Distributed Tracing:**
- Each event carries `trace_id` for end-to-end tracking
- OpenTelemetry instrumentation across all services
- Jaeger UI for trace visualization

### Security Considerations

1. **Kafka ACLs** - Each service has read/write permissions only to required topics
2. **Event Encryption** - TLS 1.3 for in-transit, KMS for at-rest
3. **Schema Validation** - All events validated against registry schemas (reject invalid events)
4. **Audit Trail** - All events retained 7 days for compliance review
5. **PII Handling** - Customer data encrypted in events, key rotation every 90 days

### Migration Strategy

**Phase 1:** Deploy Kafka and core infrastructure (Week 1-2)
**Phase 2:** Migrate Order Service to publish events (maintain sync flow as fallback) (Week 3-4)
**Phase 3:** Migrate Inventory + Warehouse services to consume events (Week 5-6)
**Phase 4:** Migrate Shipping + Notification services (Week 7-8)
**Phase 5:** Enable saga orchestration, decommission sync flow (Week 9-10)
**Phase 6:** Load testing and tuning (Week 11-12)

**Rollback Plan:** Feature flag controls event flow vs legacy synchronous flow. Can disable event-driven mode and revert to sync in < 5 minutes.
```

**Why This Is Good:**
- Comprehensive event-driven architecture with 4+ services showing realistic microservices complexity
- Idempotency implementation includes actual code demonstrating pattern in practice (not just theory)
- Failure handling covers multiple scenarios (inventory unavailable, shipping failed, service offline) with compensating transactions
- Mermaid diagram visualizes complex event flows across services clearly
- Quantified performance targets (5000 orders/hour, P95 < 5s, 99.9% uptime)
- Security, monitoring, and migration strategy show production-readiness considerations
- Kafka topic configuration with specific partitions/replication shows deep technical understanding
