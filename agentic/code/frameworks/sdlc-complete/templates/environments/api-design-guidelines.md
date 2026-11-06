# API Design Guidelines

## Metadata

- ID: ENV-API-`id`
- Owner: `name/role/team`
- Contributors: `list`
- Reviewers: `list`
- Team: `team`
- Stakeholders: `list`
- Status: `draft/in-progress/blocked/approved/done`
- Dates: created `YYYY-MM-DD` / updated `YYYY-MM-DD` / due `YYYY-MM-DD`
- Related: IFC-`id`, DES-`id`, SEC-`id`, ADR-`id`
- Links: `paths/urls`

## Related Templates

- agentic/code/frameworks/sdlc-complete/templates/analysis-design/interface-contract-card.md
- agentic/code/frameworks/sdlc-complete/templates/security/security-requirements-template.md
- agentic/code/frameworks/sdlc-complete/templates/governance/adr-template.md

## Purpose

### Guideline Scope

**Applies To**:
- All public-facing APIs
- Internal service-to-service APIs
- Partner integration APIs
- Third-party webhook interfaces

**Does Not Apply To**:
- Internal library interfaces
- Database stored procedures
- UI component interfaces

### Design Philosophy

**Core Principles**:
1. **Simplicity**: Easy to understand and use
2. **Consistency**: Predictable patterns across all APIs
3. **Evolvability**: Support change without breaking clients
4. **Developer Experience**: Optimize for API consumer productivity
5. **Performance**: Efficient use of network and compute resources

## REST API Design Principles

### Resource-Oriented Design

#### Resource Identification

**Resource Naming**:
- Use nouns, not verbs: `/users` not `/getUsers`
- Plural for collections: `/products` not `/product`
- Singular for singletons: `/profile` not `/profiles`
- Hierarchical for relationships: `/users/{id}/orders`

**Resource Hierarchy**:
```text
/organizations/{org-id}
  /teams/{team-id}
    /members/{member-id}
    /projects/{project-id}
      /tasks/{task-id}
```

**Collection vs Resource**:
- Collection: `/products` - represents multiple items
- Resource: `/products/{id}` - represents single item
- Nested resource: `/users/{id}/preferences` - resource scoped to parent

#### Resource Representation

**Field Naming Conventions**:
- Use camelCase: `firstName` not `first_name` or `FirstName`
- Use meaningful names: `createdAt` not `ct` or `created_timestamp`
- Avoid abbreviations: `description` not `desc`
- Boolean prefixes: `isActive`, `hasPermission`, `canEdit`

**Common Fields**:
```json
{
  "id": "unique-identifier",
  "createdAt": "ISO-8601 timestamp",
  "updatedAt": "ISO-8601 timestamp",
  "version": "resource version",
  "links": {
    "self": "resource URI",
    "related": ["related resource URIs"]
  }
}
```

### HTTP Method Semantics

#### Standard CRUD Operations

| Method | URI Pattern | Semantics | Success Status | Idempotent | Safe |
| ------ | ----------- | --------- | -------------- | ---------- | ---- |
| GET | /resources | List resources | 200 OK | Yes | Yes |
| GET | /resources/{id} | Retrieve resource | 200 OK | Yes | Yes |
| POST | /resources | Create resource | 201 Created | No | No |
| PUT | /resources/{id} | Replace resource | 200 OK | Yes | No |
| PATCH | /resources/{id} | Update resource | 200 OK | No | No |
| DELETE | /resources/{id} | Delete resource | 204 No Content | Yes | No |

#### Method Guidelines

**GET**:
- Must not modify state
- Support caching via ETags
- Support conditional requests (If-None-Match)
- Return 200 for success, 404 for not found
- Use query parameters for filtering, sorting, pagination

**POST**:
- Creates new resource
- Return 201 with Location header pointing to new resource
- Return resource representation in response body
- Use for non-idempotent operations
- Can be used for complex queries (POST to /search)

**PUT**:
- Full replacement of resource
- Must include all fields (missing fields set to null/default)
- Return 200 with updated resource or 204 with no content
- Create resource if doesn't exist (optional pattern)
- Client provides resource ID

**PATCH**:
- Partial update of resource
- Include only fields to change
- Use JSON Patch (RFC 6902) or JSON Merge Patch (RFC 7396)
- Return 200 with updated resource
- Minimize network payload

**DELETE**:
- Remove resource
- Return 204 No Content or 200 with deletion summary
- Idempotent: deleting already-deleted resource returns same status
- Support soft delete via status field change (optional)

### URL Design Patterns

#### Path Structure

**General Pattern**:
```text
https://{host}/{version}/{namespace}/{resource}/{id}/{sub-resource}/{sub-id}
```

**Examples**:
```text
https://api.example.com/v1/users/123
https://api.example.com/v1/users/123/orders
https://api.example.com/v1/organizations/abc/teams/xyz/members
```

#### Query Parameters

**Standard Parameters**:

| Parameter | Purpose | Example | Notes |
| --------- | ------- | ------- | ----- |
| filter | Filter results | ?filter=status:active | Use colon for operator |
| sort | Sort results | ?sort=-createdAt | Use - for descending |
| page | Pagination | ?page=2 | Offset-based |
| limit | Page size | ?limit=50 | Max results per page |
| fields | Sparse fields | ?fields=id,name | Comma-separated |
| include | Related resources | ?include=author,comments | Avoid N+1 queries |

**Filtering Patterns**:
```text
?filter=status:active                    # Exact match
?filter=price>100                        # Greater than
?filter=name~john                        # Contains
?filter=createdAt>=2024-01-01            # Date range
?filter=tags@>marketing                  # Array contains
?filter=status:active,verified:true      # Multiple filters (AND)
```

### Response Structure

#### Success Response Format

**Single Resource**:
```json
{
  "data": {
    "id": "123",
    "type": "user",
    "attributes": {
      "name": "John Doe",
      "email": "john@example.com"
    },
    "relationships": {
      "organization": {
        "data": { "type": "organization", "id": "456" }
      }
    },
    "links": {
      "self": "/users/123"
    }
  },
  "meta": {
    "version": "1.2.3",
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
```

**Collection Response**:
```json
{
  "data": [
    { "id": "1", "type": "user", "attributes": {...} },
    { "id": "2", "type": "user", "attributes": {...} }
  ],
  "meta": {
    "totalCount": 150,
    "pageCount": 8,
    "currentPage": 1,
    "perPage": 20
  },
  "links": {
    "self": "/users?page=1",
    "next": "/users?page=2",
    "last": "/users?page=8"
  }
}
```

#### Error Response Format

**Standard Error Structure**:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "email",
        "issue": "Invalid email format",
        "value": "not-an-email",
        "location": "body"
      }
    ],
    "timestamp": "2024-01-15T10:30:00Z",
    "traceId": "abc-123-def-456",
    "helpUrl": "https://docs.example.com/errors/validation"
  }
}
```

**HTTP Status Codes**:

| Code | Meaning | Use Case |
| ---- | ------- | -------- |
| 200 | OK | Successful GET, PUT, PATCH, DELETE |
| 201 | Created | Successful POST |
| 204 | No Content | Successful DELETE, PUT with no response body |
| 400 | Bad Request | Validation error, malformed request |
| 401 | Unauthorized | Authentication required or failed |
| 403 | Forbidden | Authenticated but not authorized |
| 404 | Not Found | Resource does not exist |
| 409 | Conflict | Resource state conflict (e.g., duplicate) |
| 422 | Unprocessable Entity | Semantic validation error |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Unexpected server error |
| 503 | Service Unavailable | Temporary unavailability |

### Pagination Strategies

#### Offset-Based Pagination

**Request**:
```text
GET /users?page=2&limit=20
```

**Response**:
```json
{
  "data": [...],
  "meta": {
    "currentPage": 2,
    "perPage": 20,
    "totalCount": 150,
    "pageCount": 8
  },
  "links": {
    "first": "/users?page=1&limit=20",
    "prev": "/users?page=1&limit=20",
    "next": "/users?page=3&limit=20",
    "last": "/users?page=8&limit=20"
  }
}
```

**Use When**: Stable datasets, page navigation needed

#### Cursor-Based Pagination

**Request**:
```text
GET /users?cursor=eyJpZCI6MTIzfQ&limit=20
```

**Response**:
```json
{
  "data": [...],
  "meta": {
    "hasMore": true,
    "nextCursor": "eyJpZCI6MTQzfQ"
  },
  "links": {
    "next": "/users?cursor=eyJpZCI6MTQzfQ&limit=20"
  }
}
```

**Use When**: Real-time data, large datasets, no page jumps needed

#### Keyset Pagination

**Request**:
```text
GET /users?after_id=123&limit=20
```

**Use When**: Efficient deep pagination, time-series data

### Versioning Strategy

#### Version in URL Path

**Pattern**: `/v{major}/resources`

**Examples**:
```text
https://api.example.com/v1/users
https://api.example.com/v2/users
```

**Pros**: Clear, simple, cacheable
**Cons**: URL changes on version bump

#### Version in Header

**Pattern**: `API-Version: {major}.{minor}`

**Example**:
```http
GET /users
API-Version: 1.2
```

**Pros**: Clean URLs, granular control
**Cons**: Less visible, harder to cache

#### Version in Content Negotiation

**Pattern**: `Accept: application/vnd.api+json;version={version}`

**Example**:
```http
GET /users
Accept: application/vnd.api+json;version=1.2
```

**Pros**: RESTful, flexible
**Cons**: Complex, harder to use

#### Versioning Rules

**Major Version (v1 → v2)**:
- Breaking changes only
- Incompatible with previous version
- Run both versions in parallel
- 6-12 month deprecation period

**Minor Version (v1.0 → v1.1)**:
- Backward compatible additions
- New optional fields
- New endpoints
- No client changes required

**Patch Version (v1.1.0 → v1.1.1)**:
- Bug fixes only
- No API changes
- Transparent to clients

### Authentication Patterns

#### Bearer Token

**Header**:
```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Use Case**: User authentication, OAuth 2.0
**Token Type**: JWT, opaque token
**Lifetime**: Short-lived (1 hour typical)

#### API Key

**Header**:
```http
X-API-Key: ak_live_abc123def456
```

**Use Case**: Service-to-service, partner integrations
**Lifetime**: Long-lived, rotated periodically
**Security**: Include rate limiting, IP whitelisting

#### mTLS (Mutual TLS)

**Certificate**: Client presents certificate for authentication

**Use Case**: High-security service-to-service
**Complexity**: High setup cost
**Security**: Strongest authentication

### Authorization Patterns

#### Role-Based Access Control (RBAC)

**Roles**: admin, user, guest, service

**Permissions**:
```json
{
  "admin": ["read", "write", "delete", "admin"],
  "user": ["read", "write:own"],
  "guest": ["read"]
}
```

**Enforcement**: Check role → verify permission → allow/deny

#### Attribute-Based Access Control (ABAC)

**Attributes**: User attributes, resource attributes, environment

**Policy**:
```text
Allow if:
  user.department == resource.department AND
  user.level >= resource.requiredLevel AND
  environment.time between 09:00 and 17:00
```

**Enforcement**: Evaluate policy → allow/deny

### Rate Limiting

#### Rate Limit Headers

**Request**:
```http
GET /users
```

**Response**:
```http
HTTP/1.1 200 OK
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1641945600
Retry-After: 3600
```

#### Rate Limit Algorithms

**Token Bucket**:
- Tokens refill at fixed rate
- Burst allowed up to bucket size
- Flexible and fair

**Fixed Window**:
- Count requests per time window
- Simple to implement
- Edge case: burst at window boundary

**Sliding Window**:
- Weighted count across windows
- Smooth rate enforcement
- More complex

#### Rate Limit Tiers

| Tier | Requests/Hour | Burst | Use Case |
| ---- | ------------- | ----- | -------- |
| Anonymous | 100 | 10 | Unauthenticated |
| Basic | 1,000 | 50 | Free tier |
| Pro | 10,000 | 200 | Paid tier |
| Enterprise | 100,000 | 1000 | High volume |

### Caching Strategy

#### Cache Headers

**Response**:
```http
HTTP/1.1 200 OK
Cache-Control: max-age=300, private
ETag: "version-123"
Last-Modified: Sat, 15 Jan 2024 10:30:00 GMT
Vary: Accept-Encoding, Authorization
```

**Cache-Control Directives**:
- `public`: Cacheable by any cache
- `private`: Cacheable by client only
- `no-cache`: Revalidate before use
- `no-store`: Do not cache
- `max-age=seconds`: Cache lifetime

#### Conditional Requests

**Request with ETag**:
```http
GET /users/123
If-None-Match: "version-123"
```

**Response if not modified**:
```http
HTTP/1.1 304 Not Modified
```

**Request with Last-Modified**:
```http
GET /users/123
If-Modified-Since: Sat, 15 Jan 2024 10:30:00 GMT
```

### Content Negotiation

#### Request Content Type

**Header**:
```http
Content-Type: application/json; charset=utf-8
```

**Supported Types**:
- `application/json`: Default, preferred
- `application/xml`: Legacy support
- `application/x-www-form-urlencoded`: Form data
- `multipart/form-data`: File uploads

#### Response Content Type

**Header**:
```http
Accept: application/json
Accept-Language: en-US,en;q=0.9
Accept-Encoding: gzip, deflate, br
```

**Response**:
```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Content-Language: en-US
Content-Encoding: gzip
```

### Idempotency

#### Idempotency Key

**Header**:
```http
POST /payments
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json

{
  "amount": 100.00,
  "currency": "USD"
}
```

**Server Behavior**:
1. Receive request with idempotency key
2. Check if key exists in cache/database
3. If exists, return cached response
4. If not, process request and cache response
5. Return result

**Use Cases**: Payments, order creation, critical operations

#### Naturally Idempotent

- GET: Always safe and idempotent
- PUT: Replaces resource, same result on repeat
- DELETE: Deletes resource, same result on repeat

#### Non-Idempotent

- POST: Creates new resource each time
- PATCH: May have different results on repeat

## Data Format Standards

### Date and Time

**Format**: ISO 8601

**Examples**:
```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "date": "2024-01-15",
  "time": "10:30:00",
  "dateTime": "2024-01-15T10:30:00+00:00"
}
```

**Rules**:
- Always use UTC for timestamps
- Include timezone offset
- Use Z suffix for UTC

### Numbers

**Integer**: `123`
**Decimal**: `123.45` (avoid floating point precision issues)
**Currency**: Use decimal with fixed precision, include currency code

```json
{
  "amount": "100.00",
  "currency": "USD"
}
```

### Strings

**Encoding**: UTF-8
**Empty values**: `""` or omit field (based on optionality)
**Null values**: Use `null` for explicitly null values

### Arrays

**Empty array**: `[]`
**Homogeneous**: All elements same type
**Ordered**: Preserve order if meaningful

### Enumerations

**Format**: Uppercase snake_case or SCREAMING_SNAKE_CASE

```json
{
  "status": "ACTIVE",
  "priority": "HIGH"
}
```

**Extensibility**: Document how new values will be added

## Error Handling

### Error Categories

| Category | HTTP Status | Retry | Client Action |
| -------- | ----------- | ----- | ------------- |
| Client Error | 4xx | No | Fix request |
| Server Error | 5xx | Yes | Retry with backoff |
| Rate Limit | 429 | Yes | Honor Retry-After |

### Error Detail Levels

**Production**:
```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred",
    "traceId": "abc-123"
  }
}
```

**Development**:
```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Database connection failed",
    "traceId": "abc-123",
    "debug": {
      "exception": "SQLException",
      "stackTrace": "..."
    }
  }
}
```

## API Documentation Standards

### OpenAPI Specification

**Required Sections**:
- Info: API title, description, version
- Servers: Base URLs for environments
- Paths: All endpoints with operations
- Components: Schemas, responses, parameters
- Security: Security schemes

**Documentation Level**:
- Every endpoint documented
- Every parameter described
- Every response code documented
- Examples for all operations
- Error codes cataloged

### Interactive Documentation

**Tools**: Swagger UI, Redoc, Postman
**Features**: Try-it-out, code generation, mock server

## Testing Guidelines

### Contract Testing

**Provider Tests**: Verify API matches spec
**Consumer Tests**: Verify clients use API correctly
**Tools**: Pact, Spring Cloud Contract

### Performance Testing

**Load Testing**: Sustained request rate
**Stress Testing**: Peak request rate
**Endurance Testing**: Long-duration stability

## Migration Strategies

### Backward Compatibility

**Safe Changes**:
- Add optional fields
- Add new endpoints
- Add enum values (if extensible)
- Relax validation

**Breaking Changes**:
- Remove fields
- Rename fields
- Change field types
- Tighten validation
- Remove endpoints

### Deprecation Process

1. **Announce**: Document deprecation timeline
2. **Warn**: Add deprecation headers
3. **Monitor**: Track deprecated endpoint usage
4. **Migrate**: Provide migration guide
5. **Remove**: After sunset date

**Deprecation Header**:
```http
Deprecation: true
Sunset: Sat, 31 Dec 2024 23:59:59 GMT
Link: <https://docs.example.com/migration>; rel="deprecation"
```

## Security Best Practices

### Input Validation

- Validate all inputs server-side
- Use allow-lists, not deny-lists
- Enforce length limits
- Sanitize special characters

### Authentication

- Use HTTPS always
- Implement token expiration
- Support token refresh
- Rate limit authentication attempts

### Authorization

- Default deny
- Principle of least privilege
- Validate authorization on every request
- Log authorization failures

### Data Protection

- Encrypt sensitive data at rest
- Use TLS 1.3 for transit
- Mask PII in logs
- Implement data retention policies

## Validation Checklist

- [ ] Resource naming follows conventions
- [ ] HTTP methods used correctly
- [ ] URL structure is consistent
- [ ] Response format is standardized
- [ ] Error handling is comprehensive
- [ ] Authentication is implemented
- [ ] Authorization is enforced
- [ ] Rate limiting is configured
- [ ] Caching headers are set
- [ ] API is versioned
- [ ] Documentation is complete
- [ ] Tests cover all endpoints
- [ ] Security best practices followed

## Appendices

### A. Complete Example API

[Full example showing all patterns]

### B. Code Samples

[Client code examples in multiple languages]

### C. Common Mistakes

[Anti-patterns and how to avoid them]

### D. Migration Checklist

[Step-by-step guide for API changes]