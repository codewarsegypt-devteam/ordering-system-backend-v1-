# Frontend Changes - Table Session Flow

This file documents the backend changes required by frontend to support one active table session per table.

## What Changed

- Orders created from table QR now auto-link to an active `table_session`.
- If the table has no active session, backend auto-creates one.
- Session close is now explicit via a dedicated endpoint.
- Session totals are currently computed from orders (no stored session total column).

## Updated Order Create Response

Endpoint:

```http
POST /orders?t=<QR_TABLE_TOKEN>
Content-Type: application/json
```

Body (same as current flow):

```json
{
  "items": [
    {
      "item_id": "uuid",
      "variant_id": "uuid or null",
      "quantity": 2,
      "modifiers": [{ "modifier_id": "uuid", "quantity": 1 }]
    }
  ],
  "display_currency_id": "uuid or null"
}
```

New response field:

```json
{
  "order_id": "uuid",
  "table_session_id": "uuid",
  "order_number": "1001",
  "status": "placed",
  "total_price": 120.5,
  "display_total_price": 120.5,
  "display_currency_id": "uuid or null",
  "display_exchange_rate": 1
}
```

## New Public Endpoint (Customer Side)

Get current active session for scanned table token:

```http
GET /table-sessions/active?t=<QR_TABLE_TOKEN>
```

Response when active session exists:

```json
{
  "active_session": {
    "id": "uuid",
    "merchant_id": "uuid",
    "branch_id": "uuid",
    "table_id": "uuid",
    "status": "active",
    "opened_at": "2026-03-24T10:00:00.000Z",
    "closed_at": null,
    "orders_count": 3,
    "open_orders_count": 1,
    "total_price": 350,
    "display_total_price": 350
  },
  "orders": [
    {
      "id": "uuid",
      "order_number": "1001",
      "status": "completed",
      "total_price": 120.5,
      "display_total_price": 120.5,
      "created_at": "2026-03-24T10:01:00.000Z"
    }
  ]
}
```

Response when no active session:

```json
{
  "active_session": null
}
```

## New Staff Endpoints (Dashboard Side)

Requires:

- `Authorization: Bearer <token>`
- `requireMerchant`
- `requireStaff`

### 1) List all sessions (open + closed)

```http
GET /table-sessions?status=<optional>&branch_id=<optional>&table_id=<optional>&opened_by_type=<optional>&from=<ISO>&to=<ISO>&sort_by=opened_at|closed_at|created_at&sort_dir=asc|desc&include_orders=true&limit=50&page=1
```

Notes:

- No `status` filter means all statuses.
- You can filter by one status (`active`) or comma list (`active,closed`).
- `from` / `to` filters apply on `opened_at`.
- If both are provided, backend requires `from <= to`.
- Pagination fields are included in response: `pagination.page`, `pagination.total_pages`, etc.
- `include_orders=true` returns each session with nested `orders`.

### 2) List all open sessions now

```http
GET /table-sessions/open?branch_id=<optional>&table_id=<optional>&opened_by_type=<optional>&from=<ISO>&to=<ISO>&include_orders=true&limit=50
```

Notes:

- `include_orders=true` returns each session with nested `orders`.
- `include_orders=false` (or omitted) returns only session summaries.
- `from` / `to` filters apply on `opened_at`.
- Cashier/Kitchen are always restricted to their own branch.

Response (`include_orders=false`):

```json
{
  "data": [
    {
      "id": "uuid",
      "merchant_id": "uuid",
      "branch_id": "uuid",
      "table_id": "uuid",
      "status": "active",
      "opened_at": "2026-03-24T10:00:00.000Z",
      "orders_count": 3,
      "open_orders_count": 1,
      "total_price": 350,
      "display_total_price": 350
    }
  ],
  "count": 1
}
```

Response (`include_orders=true`):

```json
{
  "data": [
    {
      "id": "uuid",
      "status": "active",
      "orders_count": 3,
      "open_orders_count": 1,
      "total_price": 350,
      "display_total_price": 350,
      "orders": [
        {
          "id": "uuid",
          "table_session_id": "uuid",
          "order_number": "1001",
          "status": "placed",
          "total_price": 120.5,
          "display_total_price": 120.5,
          "created_at": "2026-03-24T10:01:00.000Z"
        }
      ]
    }
  ],
  "count": 1
}
```

### 3) Get orders of a specific session

```http
GET /table-sessions/:sessionId/orders
```

Response:

```json
{
  "session": {
    "id": "uuid",
    "status": "active",
    "orders_count": 4,
    "open_orders_count": 0,
    "total_price": 500,
    "display_total_price": 500
  },
  "orders": [{ "id": "uuid", "status": "completed", "total_price": 120.5 }]
}
```

### 4) Close table session

```http
PATCH /table-sessions/:sessionId/close
```

Success response:

```json
{
  "session": {
    "id": "uuid",
    "status": "closed",
    "closed_at": "2026-03-24T11:00:00.000Z",
    "orders_count": 4,
    "open_orders_count": 0,
    "total_price": 500,
    "display_total_price": 500
  },
  "orders_count": 4
}
```

Conflict response if there are open (non-terminal) orders:

```json
{
  "error": "Cannot close session with non-terminal orders",
  "open_orders_count": 2,
  "open_order_ids": ["uuid1", "uuid2"]
}
```

HTTP status: `409`.

## Frontend Integration Flow

1. Customer scans table QR and gets token `t`.
2. Frontend calls `GET /table-sessions/active?t=...`:
   - if active session exists, show current check/orders.
   - if null, do nothing (session will auto-open on first order).
3. On checkout, call `POST /orders?t=...` (same payload as before).
4. Use returned `table_session_id` to track the current check in frontend state.
5. Staff dashboard uses `GET /table-sessions/:sessionId/orders`.
6. Cashier closes check using `PATCH /table-sessions/:sessionId/close` after all orders are terminal.

## Important DB Note

For correctness under concurrent requests, add a unique partial index in DB:

- one active session per table (`status = 'active'`).

Without this index, simultaneous requests may still create duplicate active sessions in rare race cases.
