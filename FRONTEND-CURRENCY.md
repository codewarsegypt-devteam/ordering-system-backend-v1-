# Frontend Multi-Currency Display — Implementation Guide

This document describes every change needed in the frontend to support the new multi-currency display system.

> **Architecture reminder:** This is NOT a multi-currency pricing system.  
> All real prices live in the merchant's **base currency**.  
> All other currencies are **display only** — converted at render time.  
> The customer never changes a price; they only see a converted view.

---

## Table of Contents

1. [New API Response Shapes](#1-new-api-response-shapes)
2. [Global State / Context Changes](#2-global-state--context-changes)
3. [QR Scan Flow](#3-qr-scan-flow)
4. [Menu Page](#4-menu-page)
5. [Cart / Checkout Flow](#5-cart--checkout-flow)
6. [Order Confirmation](#6-order-confirmation)
7. [Admin Panel — Currency Management](#7-admin-panel--currency-management)
8. [Utility Helper Functions](#8-utility-helper-functions)
9. [Edge Cases & Fallbacks](#9-edge-cases--fallbacks)

---

## 1. New API Response Shapes

### 1.1 `currency_info` block (appears in Scan, Menu, and ValidateCart responses)

```ts
interface CurrencyInfo {
  base_currency: Currency | null;
  display_currency: Currency | null;      // the currently resolved display currency
  display_rate: number;                   // how many display units = 1 base unit
  default_display_currency: Currency | null;
  available_currencies: AvailableCurrency[];
}

interface Currency {
  id: number;
  code: string;   // "EGP", "USD", "EUR"
  name: string;   // "Egyptian Pound"
  symbol: string; // "ج.م", "$", "€"
}

interface AvailableCurrency {
  currency_id: number;
  rate_from_base: number;
  is_default_display: boolean;
  currency: Currency;
}
```

### 1.2 Item prices (in `GET /public/menu/:id` response)

Each item now includes:
```ts
{
  base_price: number;       // always in base currency (e.g. 150 EGP)
  display_price: number;    // converted (e.g. 3.15 USD)
  base_currency: Currency;
  display_currency: Currency;
  variants: Array<{
    price: number;          // base price
    display_price: number;  // converted
    // ...rest of variant
  }>;
  modifier_groups: Array<{
    modifiers: Array<{
      price: number;        // base price
      display_price: number; // converted
      // ...rest of modifier
    }>;
  }>;
}
```

### 1.3 Validate Cart response

```ts
{
  is_valid: boolean;
  errors: string[];
  totals: {
    subtotal: number;           // base currency total
    total: number;              // base currency total
    display_subtotal: number;   // display currency total
    display_total: number;      // display currency total
  };
  currency_info: {
    display_currency: Currency | null;
    display_rate: number;
  };
  line_items: Array<{
    item_id: number;
    variant_id: number | null;
    unit_price: number;           // base
    qty: number;
    line_total: number;           // base
    display_unit_price: number;   // display
    display_line_total: number;   // display
  }>;
}
```

### 1.4 Create Order response

```ts
{
  order_id: number;
  order_number: string;
  status: string;
  total_price: number;              // base currency
  display_total_price: number;      // display currency
  display_currency_id: number | null;
  display_exchange_rate: number;
}
```

---

## 2. Global State / Context Changes

Add a `CurrencyContext` (or extend your existing app context) with:

```ts
interface CurrencyState {
  baseCurrency: Currency | null;
  selectedCurrency: Currency | null;   // what the customer chose (or default)
  selectedRate: number;                // rate_from_base for selectedCurrency
  availableCurrencies: AvailableCurrency[];
}
```

### Initialization

- Initialize from the `GET /public/scan` response's `currency_info` block.
- Set `selectedCurrency` = `currency_info.default_display_currency`
- Set `selectedRate` = `currency_info.default_display_rate`
- Persist selection in `sessionStorage` so it survives page refresh (key: `selected_currency_id`).

### On Currency Change

When the customer switches currency:
1. Update `selectedCurrency` and `selectedRate` in state.
2. Persist `selectedCurrency.id` to `sessionStorage`.
3. Re-fetch the menu with `?currency_id=<newId>` — **OR** (better for UX) recompute display prices client-side using the rate from `available_currencies` without a new API call.

---

## 3. QR Scan Flow

**Endpoint:** `GET /public/scan?t=<qrToken>`

### Changes needed

1. **After scan succeeds**, read `response.currency_info` and initialize the `CurrencyContext`.
2. **Restore persisted selection**: check `sessionStorage.getItem('selected_currency_id')`. If found and it exists in `available_currencies`, set that as the selected currency.
3. **Store** `merchant_id`, `branch_id`, `table_id`, `qrToken` as before.

### Example

```ts
const data = await scanQR(token);

// Initialize currency context
const savedCurrencyId = sessionStorage.getItem('selected_currency_id');
const savedCurrency = data.currency_info.available_currencies.find(
  (c) => c.currency_id === Number(savedCurrencyId)
);

setCurrencyState({
  baseCurrency: data.currency_info.base_currency,
  selectedCurrency: savedCurrency?.currency ?? data.currency_info.default_display_currency,
  selectedRate: savedCurrency?.rate_from_base ?? data.currency_info.default_display_rate,
  availableCurrencies: data.currency_info.available_currencies,
});
```

---

## 4. Menu Page

**Endpoint:** `GET /public/menu/:menuId?t=<token>&currency_id=<id>`

### 4.1 Currency Selector Component

Add a floating/sticky currency picker to the menu page. Requirements:

```
[ EGP ▼ ]  ← dropdown showing available currencies
```

- Show currency `code` and `symbol`.
- Highlight the currently selected currency.
- On select: update context + re-render prices (no need to re-fetch if you recompute client-side).
- If `available_currencies` is empty, hide the selector entirely.

```tsx
function CurrencySelector() {
  const { selectedCurrency, availableCurrencies, setSelectedCurrency } = useCurrency();

  if (!availableCurrencies.length) return null;

  return (
    <select
      value={selectedCurrency?.id}
      onChange={(e) => {
        const chosen = availableCurrencies.find(c => c.currency_id === Number(e.target.value));
        if (chosen) setSelectedCurrency(chosen);
      }}
    >
      {availableCurrencies.map((c) => (
        <option key={c.currency_id} value={c.currency_id}>
          {c.currency.symbol} {c.currency.code}
        </option>
      ))}
    </select>
  );
}
```

### 4.2 Displaying Item Prices

**Use `display_price` for ALL prices shown to the customer.**  
Never show `base_price` directly. The `base_price` is only for internal calculations.

```tsx
// Item card
<span className="price">
  {selectedCurrency?.symbol} {item.display_price.toFixed(2)}
</span>

// Variant
<span>{variant.display_price.toFixed(2)} {selectedCurrency?.symbol}</span>

// Modifier
<span>+{modifier.display_price.toFixed(2)}</span>
```

### 4.3 Client-side currency switching (recommended, avoids extra API call)

When the user switches currency without re-fetching the menu, recompute from `base_price`:

```ts
function recomputeDisplayPrice(basePrice: number, newRate: number): number {
  return Math.round((basePrice * newRate + Number.EPSILON) * 100) / 100;
}
```

Apply to items, variants, and modifiers in your rendered data.

### 4.4 Fetching menu with selected currency

If you prefer server-computed prices, pass the selected currency on the menu fetch:

```ts
const menu = await fetchMenu(menuId, {
  t: qrToken,
  currency_id: selectedCurrency?.id,
});
// All display_price fields in the response will be pre-computed in the selected currency
```

---

## 5. Cart / Checkout Flow

### 5.1 Cart Item Display

In the cart, show display prices (not base prices):

```tsx
// Cart line item
<span>{selectedCurrency?.symbol} {(item.display_price * item.quantity).toFixed(2)}</span>

// Cart total
<strong>
  Total: {selectedCurrency?.symbol} {cartDisplayTotal.toFixed(2)}
</strong>
// Optionally show base price in small text for transparency:
// (Base: EGP {cartBaseTotal.toFixed(2)})
```

### 5.2 Cart Validation

Send `currency_id` with the validate request:

```ts
const result = await validateCart({
  merchant_id,
  branch_id,
  table_id,
  currency_id: selectedCurrency?.id,  // ← NEW
  items: cartItems,
});

// Use display prices from response for summary
const { display_total, display_subtotal } = result.totals;
const displayCurrency = result.currency_info.display_currency;
```

### 5.3 Order Submission

Send `display_currency_id` with the order:

```ts
const order = await createOrder({
  t: qrToken,                                     // query param
  body: {
    display_currency_id: selectedCurrency?.id,    // ← NEW field
    items: cartItems.map(item => ({
      item_id: item.id,
      variant_id: item.selectedVariant?.id ?? null,
      quantity: item.quantity,
      modifiers: item.selectedModifiers.map(m => ({
        modifier_id: m.id,
        quantity: m.quantity ?? 1,
      })),
    })),
  },
});

// Response now includes display snapshot:
// order.display_total_price  — what customer saw
// order.display_currency_id  — in which currency
// order.display_exchange_rate — rate used
```

---

## 6. Order Confirmation

On the order success screen, display the amounts the customer actually saw:

```tsx
<div className="order-confirmation">
  <p>Order #{order.order_number}</p>

  {/* Show the display total (what they saw) */}
  <p className="total-display">
    {displayCurrencySymbol} {order.display_total_price.toFixed(2)}
  </p>

  {/* Optionally show base total for clarity */}
  {/* <p className="total-base">({baseCurrencySymbol} {order.total_price.toFixed(2)})</p> */}
</div>
```

Store `display_currency_id` and `display_exchange_rate` from the order response in case you need to show them later.

---

## 7. Admin Panel — Currency Management

### 7.1 Routes needed

Add these pages/sections to the admin panel (owner role only):

```
/admin/currencies             → Merchant currency setup
/admin/currencies/base        → Set base currency
/admin/currencies/display     → Manage display currencies
```

Or integrate into an existing Settings page under a "Currencies" tab.

---

### 7.2 Page: Get Currency Setup

**Call:** `GET /currencies/merchant`

Display:
- **Base Currency:** the single source of truth. Show a "Change" button.
- **Display Currencies:** table with columns: Currency, Code, Symbol, Rate, Active, Default, Actions.

```
Base Currency:  Egyptian Pound (EGP)  [Change]

Display Currencies:
┌──────────────┬──────┬────────┬────────────────┬────────┬─────────┬─────────────┐
│ Currency     │ Code │ Symbol │ Rate from Base │ Active │ Default │ Actions     │
├──────────────┼──────┼────────┼────────────────┼────────┼─────────┼─────────────┤
│ US Dollar    │ USD  │ $      │ 0.0210         │ ✅     │ ★       │ Edit Delete │
│ Euro         │ EUR  │ €      │ 0.0190         │ ✅     │         │ Edit Delete │
└──────────────┴──────┴────────┴────────────────┴────────┴─────────┴─────────────┘

[+ Add Display Currency]
```

---

### 7.3 Set Base Currency

**Call:** `PATCH /currencies/merchant/base`  
**Body:** `{ currency_id: number }`

```tsx
// 1. Fetch all global currencies first
const allCurrencies = await fetch('/currencies');

// 2. Show dropdown of all active currencies
<select value={selectedBaseCurrencyId} onChange={...}>
  {allCurrencies.filter(c => c.is_active).map(c => (
    <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
  ))}
</select>

// 3. On save
await patchBaseCurrency({ currency_id: selectedBaseCurrencyId });
```

⚠️ **Show a warning** before changing the base currency:
> "Changing the base currency means all item prices are now interpreted in the new currency. Make sure all item prices in the database are already in the new base currency before making this change."

---

### 7.4 Add Display Currency Form

**Call:** `POST /currencies/merchant/display`  
**Body:** `{ currency_id, rate_from_base, is_default_display? }`

```tsx
<form onSubmit={handleAdd}>
  <label>Currency</label>
  <select name="currency_id" required>
    {/* Show currencies NOT already added for this merchant */}
    {availableToAdd.map(c => (
      <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
    ))}
  </select>

  <label>Exchange Rate from Base</label>
  <input
    type="number"
    name="rate_from_base"
    step="0.000001"
    min="0.000001"
    placeholder="e.g. 0.021 (1 EGP = 0.021 USD)"
    required
  />
  <small>How many {selectedCurrencyCode} = 1 {baseCurrencyCode}</small>

  <label>
    <input type="checkbox" name="is_default_display" />
    Set as default display currency for customers
  </label>

  <button type="submit">Add Currency</button>
</form>
```

**Validation (client-side):**
- `rate_from_base` must be a positive number > 0
- Cannot add the same currency twice (disable already-added currencies in the dropdown)

---

### 7.5 Edit Display Currency

**Call:** `PATCH /currencies/merchant/display/:mcId`

Fields editable:
- `rate_from_base` — number input, must be > 0
- `is_active` — toggle (deactivate without deleting)
- `is_default_display` — radio/checkbox (only one can be default; backend enforces it)

```tsx
function EditCurrencyModal({ entry, onSave }) {
  const [rate, setRate] = useState(entry.rate_from_base);
  const [isActive, setIsActive] = useState(entry.is_active);
  const [isDefault, setIsDefault] = useState(entry.is_default_display);

  const handleSave = async () => {
    await patchDisplayCurrency(entry.id, {
      rate_from_base: rate,
      is_active: isActive,
      is_default_display: isDefault,
    });
    onSave();
  };

  return (
    <Modal>
      <input type="number" value={rate} onChange={e => setRate(Number(e.target.value))} step="0.000001" />
      <Toggle label="Active" checked={isActive} onChange={setIsActive} />
      <Toggle label="Default display currency" checked={isDefault} onChange={setIsDefault} />
      <button onClick={handleSave}>Save</button>
    </Modal>
  );
}
```

---

### 7.6 Delete Display Currency

**Call:** `DELETE /currencies/merchant/display/:mcId`

Show a confirmation dialog:
> "Remove USD as a display currency? Customers will no longer be able to view prices in USD."

---

## 8. Utility Helper Functions

Add these to a `currency.utils.ts` (or `.js`) file in your frontend:

```ts
/**
 * Format a price with currency symbol.
 * Always 2 decimal places.
 */
export function formatPrice(amount: number, currency: Currency | null): string {
  if (!currency) return amount.toFixed(2);
  return `${currency.symbol} ${amount.toFixed(2)}`;
}

/**
 * Convert a base price to display price client-side.
 * Use this for real-time currency switching without re-fetching the menu.
 */
export function convertToDisplay(basePrice: number, rate: number): number {
  const safeRate = rate > 0 ? rate : 1;
  return Math.round((basePrice * safeRate + Number.EPSILON) * 100) / 100;
}

/**
 * Get the rate for a given currency_id from the available currencies list.
 * Returns 1 if not found (safe fallback).
 */
export function getRateForCurrency(
  currencyId: number,
  availableCurrencies: AvailableCurrency[]
): number {
  return availableCurrencies.find(c => c.currency_id === currencyId)?.rate_from_base ?? 1;
}

/**
 * Recompute all display prices in a menu data structure when the customer
 * switches currency without re-fetching from the server.
 */
export function recomputeMenuPrices(categories, newRate: number) {
  return categories.map(cat => ({
    ...cat,
    items: cat.items.map(item => ({
      ...item,
      display_price: convertToDisplay(item.base_price, newRate),
      variants: item.variants.map(v => ({
        ...v,
        display_price: convertToDisplay(v.price, newRate),
      })),
      modifier_groups: item.modifier_groups.map(mg => ({
        ...mg,
        modifiers: mg.modifiers.map(m => ({
          ...m,
          display_price: convertToDisplay(m.price, newRate),
        })),
      })),
    })),
  }));
}
```

---

## 9. Edge Cases & Fallbacks

| Scenario | What backend returns | What frontend should do |
|---|---|---|
| Merchant has no base currency set | `base_currency: null`, `display_rate: 1` | Hide currency selector; show prices as-is |
| No display currencies configured | `available_currencies: []` | Hide currency selector; `display_price = base_price` |
| Customer's saved currency no longer active | Backend falls back to default | Frontend should detect mismatch and update saved value |
| Single available currency | It IS the default | Show currency name without a dropdown (no point in a 1-item selector) |
| `display_price` equals `base_price` | Rate = 1 (base = display) | Show normally; no need to hide or flag this |
| Network error fetching menu with `currency_id` | — | Fall back to menu without `currency_id` param and show default |

---

## 10. Summary of All API Calls to Update

| Area | Old call | New call (what changed) |
|---|---|---|
| Scan | `GET /public/scan?t=` | Same URL — **read `currency_info` from response** |
| Menu | `GET /public/menu/:id?t=` | Add `&currency_id=<id>` query param |
| Validate Cart | `POST /public/cart/validate` body: `{merchant_id, branch_id, items}` | Add `currency_id` to body |
| Create Order | `POST /public/create-order?t=` body: `{items}` | Add `display_currency_id` to body |
| Admin — list currencies | NEW | `GET /currencies` |
| Admin — merchant setup | NEW | `GET /currencies/merchant` |
| Admin — set base | NEW | `PATCH /currencies/merchant/base` |
| Admin — add display | NEW | `POST /currencies/merchant/display` |
| Admin — edit display | NEW | `PATCH /currencies/merchant/display/:mcId` |
| Admin — remove display | NEW | `DELETE /currencies/merchant/display/:mcId` |
