# Frontend API Documentation

This document is for **frontend developers** building:

1. **Menu website** – Customer-facing site: browse menu, build cart, place order.
2. **Dashboard** – Staff app: login, manage menu, branches, users, and process orders (kitchen/cashier).

---

## Base URL & Authentication

- **Base URL:** Your backend root (e.g. `https://api.example.com`).
- **JSON:** All request/response bodies are `application/json`.
- **Auth:** Send JWT in the header for protected routes:
  ```http
  Authorization: Bearer <access_token>
  ```
- **Errors:** API returns `{ "error": "message" }` (and sometimes `details`) with appropriate HTTP status (400, 401, 403, 404, 409, 500).

---

## Part 1: Menu Website (Customer – No Auth)

Used for the **public menu and order flow**. No login required.

### 1.1 Get menu (for display)

Load the merchant’s active menu with categories, items, variants, and modifier groups. Optional: pass table code to pre-fill branch/table for the order.

**Request**

```http
GET /public/menu?merchantId=<merchant_id>&tableCode=<optional_table_qr_code>
```

| Query       | Required | Description                                      |
|------------|----------|--------------------------------------------------|
| `merchantId` | Yes      | Merchant UUID                                   |
| `tableCode`  | No       | Table QR code; if valid, response includes `branch_id`, `table_id` |

**Response 200**

```json
{
  "merchant_id": "uuid",
  "branch_id": "uuid or null",
  "table_id": "uuid or null",
  "menu": {
    "id": "uuid",
    "merchant_id": "uuid",
    "name_ar": "...",
    "name_en": "...",
    "currancy": "EGP",
    "is_active": true,
    "created_at": "..."
  },
  "categories": [
    {
      "id": "uuid",
      "menue_id": "uuid",
      "name_ar": "...",
      "name_en": "...",
      "sort_order": 0,
      "is_active": true,
      "items": [
        {
          "id": "uuid",
          "category_id": "uuid",
          "name_ar": "...",
          "name_en": "...",
          "base_price": 50.00,
          "status": "active",
          "variants": [
            { "id": "uuid", "name_ar": "...", "name_en": "...", "price": 60.00 }
          ],
          "modifier_groups": [
            {
              "group": { "id": "uuid", "name_ar": "...", "name_en": "..." },
              "rule": { "min_select": 1, "max_select": 3 },
              "modifiers": [
                { "id": "uuid", "name_ar": "...", "name_en": "...", "price": 5.00 }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

- Only **active** categories and **active** (status `active`) items are returned.
- **Modifier rules:** Each item can have `modifier_groups` with `min_select` / `max_select`. The customer must select between min and max modifiers from each group (enforced on order create).

**Errors:** `400` (missing merchantId), `404` (menu not found).

---

### 1.2 Validate cart (before checkout)

Validate cart items, quantities, modifiers, and get a subtotal. Call this before placing the order to show errors and correct totals.

**Request**

```http
POST /public/cart/validate
Content-Type: application/json

{
  "merchant_id": "uuid",
  "branch_id": "uuid",
  "table_id": "uuid or null",
  "items": [
    {
      "item_id": "uuid",
      "variant_id": "uuid or null",
      "quantity": 1,
      "modifiers": [
        { "modifier_id": "uuid", "quantity": 1 }
      ]
    }
  ]
}
```

- **quantity:** 1–100 per line.
- **modifiers:** Must satisfy each item’s modifier group rules (min/max per group).

**Response 200**

```json
{
  "is_valid": true,
  "errors": [],
  "totals": { "subtotal": 120.50, "total": 120.50 },
  "line_items": [
    {
      "item_id": "uuid",
      "variant_id": "uuid or null",
      "unit_price": 50.00,
      "qty": 2,
      "line_total": 100.00
    }
  ]
}
```

- If validation fails: `is_valid: false`, `errors` array with messages (e.g. item not found, modifier min/max, quantity 1–100).

---

### 1.3 Create order (place order)

Creates the order. All IDs are validated (exist and belong to the same merchant). If any line fails to save, the whole order is rolled back (no incomplete orders).

**Request**

```http
POST /orders
Content-Type: application/json

{
  "merchant_id": "uuid",
  "branch_id": "uuid",
  "table_id": "uuid or null",
  "order_type": "dine_in",
  "customer_name": "Ahmed",
  "customer_phone": "+20...",
  "notes": "No onions",
  "items": [
    {
      "item_id": "uuid",
      "variant_id": "uuid or null",
      "quantity": 2,
      "modifiers": [
        { "modifier_id": "uuid", "quantity": 1 }
      ]
    }
  ]
}
```

| Field           | Required | Description |
|----------------|----------|-------------|
| `merchant_id`  | Yes      | Merchant UUID |
| `branch_id`    | Yes      | Branch UUID (must belong to merchant) |
| `table_id`     | No       | Table UUID (must belong to branch) |
| `order_type`   | Yes      | `dine_in` \| `pickup` \| `delivery` |
| `customer_name`| No       | |
| `customer_phone` | No     | |
| `notes`        | No       | |
| `items`        | Yes      | At least one line; each line: `item_id`, `quantity` (1–100), optional `variant_id`, optional `modifiers` (each with `modifier_id`, `quantity` 1–100). Modifier rules (min/max per group) are enforced. |

**Response 201**

```json
{
  "order_id": "uuid",
  "order_number": "1001",
  "status": "placed",
  "total_price": 120.50
}
```

**Errors:**  
- `400` – Invalid body, wrong IDs, item not available, modifier min/max not satisfied, quantity out of range, or save failure (order cancelled).  
- Response may include `details` with DB message on save failure.

---

## Part 2: Full Order Flow (Menu Website)

Recommended flow on the menu website:

1. **Landing / table scan**  
   - If customer scans table QR: open menu with `?merchantId=<id>&tableCode=<qr>`.  
   - Store `merchant_id`, `branch_id`, `table_id` from `GET /public/menu` for the order.

2. **Browse menu**  
   - Use `GET /public/menu?merchantId=...` and render categories → items → variants and modifier groups.  
   - For each item, enforce modifier rules (min/max per group) in the UI.

3. **Cart**  
   - Build cart client-side: array of `{ item_id, variant_id?, quantity, modifiers: [{ modifier_id, quantity }] }`.  
   - Optionally call `POST /public/cart/validate` to show errors and correct total before checkout.

4. **Checkout**  
   - Call `POST /orders` with the same structure (merchant_id, branch_id, table_id from step 1, order_type, optional customer_name/phone/notes, items).  
   - On 201, show confirmation (order_number, total).  
   - On 400, show `error` (and `details` if present).

5. **Order status (optional)**  
   - If you have a “track order” page, you would need an endpoint that accepts e.g. `order_number` + `branch_id` or a token; the current API does not expose a public “get order by number” endpoint. You can either add one or skip tracking on the menu site.

---

## Part 3: Dashboard – Authentication

All dashboard routes (except login) require a valid JWT.

### 3.1 Login

**Request**

```http
POST /auth/login
Content-Type: application/json

{ "name": "owner@admin.com", "password": "secret" }
```

**Response 200**

```json
{
  "access_token": "eyJ...",
  "user": {
    "id": "uuid",
    "name": "...",
    "merchant_id": "uuid",
    "branch_id": "uuid or null",
    "role": "owner",
    "status": "active",
    "created_at": "..."
  }
}
```

- Store `access_token` and send it as `Authorization: Bearer <access_token>` on every request.
- **Roles:** `owner` | `manager` | `cashier` | `kitchen`.

**Errors:** `400` (missing name/password), `401` (invalid credentials), `403` (account disabled).

---

### 3.2 Current user (me)

**Request**

```http
GET /auth/me
Authorization: Bearer <access_token>
```

**Response 200:** Same `user` object as in login (no password).

**Errors:** `401` if token missing/invalid/expired or user not found/disabled.

---

### 3.3 Logout

**Request**

```http
POST /auth/logout
Authorization: Bearer <access_token>
```

**Response 200:** `{ "message": "Logged out" }`.  
Client should remove the stored token.

---

## Part 4: Dashboard – Roles & Access

| Role     | Can do |
|----------|--------|
| **owner**  | Everything: users, branches/tables, menu (menus, categories, items, variants, modifiers), orders, kitchen/cashier views. |
| **manager**| Menu (menus, categories, items, variants, modifiers), view/update orders. Cannot: manage users, create/edit/delete branches or tables. |
| **cashier**| View orders (filtered by branch), update order status. Scoped to own `branch_id`. |
| **kitchen** | View orders (filtered by branch), update order status. Scoped to own `branch_id`. |

- **Merchant:** All staff have `merchant_id`; data is scoped by merchant.
- **Branch:** Cashier/kitchen have `branch_id`; they only see orders for their branch.

---

## Part 5: Dashboard – Orders

All order list/detail/status routes require: **Auth + Merchant + Staff** (owner, manager, cashier, kitchen). Cashier/kitchen are restricted to their branch.

### 5.1 List orders

```http
GET /orders?branch_id=...&status=...&from=...&to=...&q=...&limit=50&cursor=...
Authorization: Bearer <token>
```

| Query       | Description |
|------------|-------------|
| `branch_id` | Filter by branch (cashier/kitchen: forced to their branch) |
| `status`   | Comma-separated: e.g. `placed,accepted,preparing` |
| `from`     | ISO date (created_at >= from) |
| `to`        | ISO date (created_at <= to) |
| `q`         | Search by order_number (partial match) |
| `limit`     | 1–100, default 50 |
| `cursor`   | Pagination: `created_at` of last item from previous page |

**Response 200**

```json
{
  "data": [
    {
      "id": "uuid",
      "merchant_id": "uuid",
      "branch_id": "uuid",
      "table_id": "uuid or null",
      "order_number": "1001",
      "status": "placed",
      "order_type": "dine_in",
      "customer_name": "...",
      "customer_phone": "...",
      "notes": "...",
      "total_price": 120.50,
      "created_at": "..."
    }
  ],
  "next_cursor": "2025-03-01T12:00:00.000Z or null"
}
```

---

### 5.2 Get one order (with items and modifiers)

```http
GET /orders/:orderId
Authorization: Bearer <token>
```

**Response 200:** Order object plus:

```json
{
  "id": "...",
  "order_number": "1001",
  "status": "placed",
  "items": [
    {
      "id": "uuid",
      "order_id": "uuid",
      "item_id": "uuid",
      "variant_id": "uuid or null",
      "quantity": 2,
      "name_snapshot": "...",
      "price_snapshot": 50.00,
      "total_price": 100.00,
      "modifiers": [
        {
          "id": "uuid",
          "modifier_id": "uuid",
          "name_snapshot": "...",
          "price_snapshot": 5.00,
          "price": 10.00
        }
      ]
    }
  ]
}
```

---

### 5.3 Update order status

```http
PATCH /orders/:orderId/status
Authorization: Bearer <token>
Content-Type: application/json

{ "status": "accepted" }
```

**Valid statuses:**  
`draft` | `placed` | `accepted` | `preparing` | `ready` | `completed` | `cancelled`

**Response 200:** Updated order object.

**Errors:** `400` (invalid status), `404` (order not found), `403` (branch restriction for cashier/kitchen).

---

## Part 6: Kitchen & Cashier Views

Convenience endpoints that return orders in a status range suitable for kitchen or cashier.

### Kitchen orders (placed → ready)

```http
GET /kitchen/orders?branch_id=...&status=...
Authorization: Bearer <token>
```

Returns orders with status in: `placed`, `accepted`, `preparing`, `ready`.  
Kitchen role: restricted to own branch.

**Response 200:** `{ "data": [ ... ], "next_cursor": null }`

---

### Cashier orders (ready → completed/cancelled)

```http
GET /cashier/orders?branch_id=...&status=...
Authorization: Bearer <token>
```

Returns orders with status in: `ready`, `completed`, `cancelled`.  
Cashier role: restricted to own branch.

**Response 200:** `{ "data": [ ... ], "next_cursor": null }`

---

## Part 7: Dashboard – Menu Management

Requires **Auth + Merchant + Can Edit Menu** (owner or manager).

### 7.1 Menus

| Method | Path | Description |
|--------|------|-------------|
| POST   | `/menus` | Create menu. Body: `name_ar`, `name_en`, `currancy` (optional, default EGP), `is_active` (optional). |
| GET    | `/menus` | List menus for merchant. |
| GET    | `/menus/:menuId/categories` | List categories for a menu. |
| POST   | `/menus/:menuId/categories` | Create category. Body: `name_ar`, `name_en`, `description_ar`, `description_en`, `sort_order`, `img_url_1`, `is_active` (all optional except name_ar, name_en). |
| PATCH  | `/menus/:menuId` | Update menu. Body: any of `name_ar`, `name_en`, `currancy`, `is_active`. |
| DELETE | `/menus/:menuId` | Delete menu. |

---

### 7.2 Categories

| Method | Path | Description |
|--------|------|-------------|
| PATCH | `/categories/reorder` | Body: `items: [{ category_id, sort_order }, ...]`. |
| PATCH | `/categories/:categoryId` | Update category. Body: any of `name_ar`, `name_en`, `description_ar`, `description_en`, `sort_order`, `img_url_1`, `is_active`. |
| DELETE | `/categories/:categoryId` | Delete category. |

---

### 7.3 Items

| Method | Path | Description |
|--------|------|-------------|
| POST | `/categories/:categoryId/items` | Create item. Body: `name_ar`, `name_en`, `base_price` (required), `description_ar`, `description_en`, `status` (optional; default active). `status`: `active` \| `hidden` \| `out_of_stock`. |
| GET | `/categories/:categoryId/items` | List items in category. |
| GET | `/items/:itemId` | Get one item (with variants and modifier groups). |
| PATCH | `/items/:itemId` | Update item. Body: any of `name_ar`, `name_en`, `base_price`, `description_ar`, `description_en`, `status`. |
| PATCH | `/items/:itemId/status` | Set status. Body: `{ "status": "active" \| "hidden" \| "out_of_stock" }`. |
| DELETE | `/items/:itemId` | Delete item. |

---

### 7.4 Variants

| Method | Path | Description |
|--------|------|-------------|
| POST | `/items/:itemId/variants` | Create variant. Body: `name_ar`, `name_en`, `price`. |
| GET | `/items/:itemId/variants` | List variants for item. |
| PATCH | `/variants/:variantId` | Update variant. Body: any of `name_ar`, `name_en`, `price`. |
| DELETE | `/variants/:variantId` | Delete variant. |

**Validation:** Prices must be ≥ 0.

---

### 7.5 Modifier groups and modifiers

| Method | Path | Description |
|--------|------|-------------|
| POST | `/modifier-groups` | Create group. Body: `name_ar`, `name_en`. |
| GET | `/modifier-groups` | List groups. |
| PATCH | `/modifier-groups/:groupId` | Update group. Body: `name_ar`, `name_en`. |
| DELETE | `/modifier-groups/:groupId` | Delete group. |
| POST | `/modifier-groups/:groupId/modifiers` | Create modifier. Body: `name_ar`, `name_en`, `price`. |
| GET | `/modifier-groups/:groupId/modifiers` | List modifiers in group. |
| PATCH | `/modifiers/:modifierId` | Update modifier. Body: any of `name_ar`, `name_en`, `price`. |
| DELETE | `/modifiers/:modifierId` | Delete modifier. |
| POST | `/items/:itemId/modifier-groups` | Attach modifier group to item. Body: `modifier_group_id`, `min_select`, `max_select`. |
| GET | `/items/:itemId/modifier-groups` | List modifier groups attached to item. |
| PATCH | `/items/:itemId/modifier-groups/:groupId` | Update min/max. Body: `min_select`, `max_select`. |
| DELETE | `/items/:itemId/modifier-groups/:groupId` | Detach group from item. |

**Validation:** Modifier `price` ≥ 0. Order create enforces min/max selections per group.

---

## Part 8: Dashboard – Branches & Tables (Owner only)

Requires **Auth + Merchant + Can Edit Branches** (owner only).

### 8.1 Branches

| Method | Path | Description |
|--------|------|-------------|
| POST | `/branches` | Create branch. Body: `name` (required), `address`, `phone`, `is_active`. |
| GET | `/branches` | List branches. |
| PATCH | `/branches/:branchId` | Update branch. Body: any of `name`, `address`, `phone`, `is_active`. |
| DELETE | `/branches/:branchId` | Delete branch. **409** if branch has tables or orders: `{ "error": "Cannot delete, has related data (tables)" }` or `"(orders)"`. |
| POST | `/branches/:branchId/tables` | Create table. Body: `number` (required), `seats`, `is_active`, `qr_code` (optional; auto-generated if omitted). |
| GET | `/branches/:branchId/tables` | List tables. |

---

### 8.2 Tables

| Method | Path | Description |
|--------|------|-------------|
| PATCH | `/tables/:tableId` | Update table (owner). Body: any of `number`, `seats`, `is_active`, `qr_code`. |
| DELETE | `/tables/:tableId` | Delete table (owner). |
| GET | `/tables/:tableId/qr` | Get table QR info (staff). Use for displaying/printing QR for the table. |

---

## Part 9: Dashboard – Users (Owner only)

Requires **Auth + Merchant + Can Manage Users** (owner only).

| Method | Path | Description |
|--------|------|-------------|
| POST | `/users` | Create user. Body: `name`, `password`, `role` (required), `branch_id` (optional). `role`: `owner` \| `manager` \| `cashier` \| `kitchen`. Only one owner per merchant. Manager cannot create owner. |
| GET | `/users` | List users for merchant. |
| GET | `/users/:userId` | Get one user. |
| PATCH | `/users/:userId` | Update. Body: any of `name`, `role`, `branch_id`. Manager cannot set role to owner or update/delete owner. |
| PATCH | `/users/:userId/status` | Body: `{ "status": "active" \| "disabled" }`. Manager cannot change owner status. |
| PATCH | `/users/:userId/password` | Body: `{ "password": "newpassword" }` (min 6 chars). Manager cannot change owner password. |
| PATCH | `/users/:userId/branch` | Body: `{ "branch_id": "uuid or null" }`. Manager cannot change owner branch. |
| DELETE | `/users/:userId` | Delete user. Cannot delete self. Manager cannot delete owner. |

User response shape: `id`, `name`, `merchant_id`, `branch_id`, `role`, `status`, `created_at` (no password).

---

## Part 10: Dashboard – Merchant (Owner only)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/merchants` | Create merchant (if your app allows). |
| GET | `/merchants` | List merchants (typically one per owner). |
| PATCH | `/merchants/:merchantId` | Update merchant. Body: any of `name`, `logo`, `has_color_1`, `has_color_2`, `status`. Owner can only update their own merchant. |

---

## Part 11: Health

```http
GET /health
```

**Response 200:** `{ "ok": true }`. No auth.

---

## Quick reference: Order status flow

```
placed → accepted → preparing → ready → completed
                ↘ cancelled
```

- **Kitchen:** usually works with `placed` → `ready` (accept → prepare → mark ready).
- **Cashier:** usually works with `ready` → `completed` or `cancelled`.

---

## Summary: What to build

**Menu website (customer)**  
- Page: menu by merchant (and optional table code).  
- Page: cart (validate with `/public/cart/validate`).  
- Page: checkout → `POST /orders`, show order_number and total.  
- Enforce modifier min/max and quantity 1–100 in UI and rely on API validation.

**Dashboard (staff)**  
- Login (`/auth/login`), store token, use `GET /auth/me` for role and merchant/branch.  
- **Owner:** Users, branches, tables, merchant, full menu CRUD, orders.  
- **Manager:** Menu CRUD, orders (no users/branches).  
- **Cashier:** Orders list/detail/status for their branch (e.g. ready → completed).  
- **Kitchen:** Orders list/detail/status for their branch (e.g. placed → ready).  
- Use `GET /orders` with filters, or `GET /kitchen/orders` and `GET /cashier/orders` for role-specific views.

This document reflects the backend as of the last update; if you add or change endpoints, update this doc accordingly.
