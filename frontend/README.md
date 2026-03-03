# Menu & Cashier Frontend

Simple customer menu site and cashier orders view that work with the menu Backend API.

## Contents

- **index.html** – Customer: browse menu, add to cart, place order (RTL Arabic-friendly).
- **cashier.html** – Cashier: login, list orders (ready/completed/cancelled), view detail, update status.

## Setup

1. **API base URL**  
   By default, the scripts use:
   - `http://localhost:3001` when opened from `localhost`.
   - Current page origin otherwise (e.g. same Vercel domain).

   To point to another API, set `window.API_BASE` before the app scripts load:

   ```html
   <script>window.API_BASE = 'https://your-api.vercel.app';</script>
   <script src="js/config.js"></script>
   <script src="js/menu.js"></script>
   ```

2. **Customer menu URL**  
   Open the menu with a merchant id (and optional table code):

   ```
   index.html?merchantId=1
   index.html?merchantId=1&tableCode=ABC123
   ```

3. **Serving the frontend**  
   - Local: use any static server (e.g. `npx serve frontend` or open `index.html` with `file://`; for `file://` you may need to set `window.API_BASE` to your backend URL).
   - Production: deploy the `frontend` folder as static assets (e.g. Vercel, Netlify) and set `API_BASE` if the API is on another host.

## Customer flow

1. Open `index.html?merchantId=1` (and `tableCode` if ordering at a table).
2. Browse categories and items; choose variant and modifiers (respecting min/max).
3. Add to cart, adjust quantity (1–100).
4. Click “إتمام الطلب” (Checkout). If no table code, a message asks to scan the table QR.
5. Fill order type, optional name/phone/notes; submit. On success, order number and total are shown.

## Cashier flow

1. Open `cashier.html`, log in with staff credentials (e.g. cashier role).
2. View orders list (filter by status: ready, completed, cancelled).
3. Click “عرض” on a row to open order detail.
4. Use “تم التسليم” to set status to completed, or “إلغاء الطلب” to cancel.

## Files

- `css/style.css` – Shared styles (customer + cashier).
- `js/config.js` – API base URL and URL params helpers.
- `js/menu.js` – Menu fetch, cart, checkout, place order.
- `js/cashier.js` – Login, orders list, order detail, status update.
