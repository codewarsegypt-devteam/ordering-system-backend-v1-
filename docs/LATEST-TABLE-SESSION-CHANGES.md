# Latest Table Session Changes

Date: 2026-03-24

This file summarizes the latest backend changes related to table sessions.

## 1) Table Session APIs moved to dedicated module

Table session logic is no longer inside order routes/controller.

### New files

- `controllers/tableSessions.controller.js`
- `routes/tableSessions.routes.js`
- `lib/tableSessions.js`

## 2) New base route for table sessions

Registered in `app.js`:

- `app.use("/table-sessions", tableSessionsRoutes);`

Exported in `routes/index.js`:

- `tableSessionsRoutes`

## 3) Endpoints now under `/table-sessions`

### Public (QR token)

- `GET /table-sessions/active?t=<QR_TABLE_TOKEN>`

Returns active session for scanned table (or `active_session: null`) with session orders.

### Staff (Auth + Merchant + Staff)

- `GET /table-sessions?status=<optional>&branch_id=<optional>&table_id=<optional>&opened_by_type=<optional>&from=<ISO>&to=<ISO>&sort_by=opened_at|closed_at|created_at&sort_dir=asc|desc&include_orders=true|false&limit=<1..200>&page=<>=1`
- `GET /table-sessions/open?branch_id=<optional>&table_id=<optional>&opened_by_type=<optional>&from=<ISO>&to=<ISO>&include_orders=true|false&limit=<1..200>`
- `GET /table-sessions/:sessionId/orders`
- `PATCH /table-sessions/:sessionId/close`

Close endpoint returns `409` if there are non-terminal orders in session.

## 4) Orders create now auto-links table session

In `orders.controller.create`:

- Backend gets/creates one active session for table.
- New orders are inserted with `table_session_id`.
- Order response now includes `table_session_id`.

## 5) Removed old order-prefixed session routes

These are no longer used:

- `/orders/table-session/active`
- `/orders/table-session/open`
- `/orders/table-session/:sessionId/orders`
- `/orders/table-session/:sessionId/close`

Use `/table-sessions/...` instead.

## 6) Shared session helper behavior

`lib/tableSessions.js` now centralizes:

- Token verification for table QR
- Get active session
- Get-or-create active session with basic race handling
- Session response summary (`orders_count`, `open_orders_count`, totals)
- Session access guard by merchant/branch role

## 7) Frontend impact

Frontend must update API calls to new paths:

- From `/orders/table-session/*`
- To `/table-sessions/*`

Detailed frontend integration examples are in:

- `docs/FRONTEND-TABLE-SESSION-CHANGES.md`
