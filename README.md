# Blissmark API

NestJS 11 + Prisma 6 + PostgreSQL. Serves the customer app (`../customer-app`). All money is integer **paise**.

## Run locally (Windows)

```bash
npm install
npm run db:start      # private PostgreSQL 18 instance in .pgdata (port 5433, trust auth, localhost only)
npx prisma migrate dev
npx prisma db seed    # demo data (only on an empty database)
npm run build && npm start     # http://localhost:4000/v1   (or: npm run dev)
```

`npm run db:stop` stops the database. The instance uses the PostgreSQL 18 binaries already installed at
`C:\Program Files\PostgreSQL\18\bin` (override with `PG_BIN`). It is separate from the system PostgreSQL service.

Demo login: phone `9876543210`, OTP `482193` (`DEV_OTP` in `.env`). New sign-ups need sponsor code `BLISS-R7K2M9` or `BLISS-A1B2C3`.

## Modules

| Module | Endpoints (prefix `/v1`) |
|---|---|
| auth, users | `POST auth/otp/send`, `auth/otp/verify`, `auth/register` · `GET referrals/validate` · `GET/PATCH me` · `me/addresses` CRUD |
| home | `GET home` (one call for the Home screen), `GET search?q=`, `GET health` |
| shop | `GET categories`, `products`, `products/:id` · `cart` (+ `cart/items`, `cart/coupon`) · `POST checkout` · `GET orders`, `orders/:id`, `POST orders/:id/cancel` |
| bookings | `GET services`, `services/:code` · `POST bookings` · `GET bookings`, `bookings/:id` · `POST bookings/:id/cancel`, `quote/approve`, `quote/decline`, `pay`, `rating` |
| wallet | `GET wallet?type=` · `POST wallet/topup`, `wallet/withdrawals` (double-entry ledger, `ledger.service.ts`) |
| income | `GET income/summary`, `income/network/:level`, `income/statements/:month` · `GET/POST subscription` |
| notifications | `GET notifications`, `POST notifications/read` |

Errors are always `{ "error": { "code", "message", "fields"? } }`; field messages map to form inputs in the app.

## What is simulated (until the vendor app, Razorpay and couriers exist)

- **Vendors**: `BookingsService.simulate()` plays the vendor side on a short clock (accept 8s, on the way 10s, start 30s, estimate, complete, invoice). Replace with real vendor-app actions.
- **Courier**: `ShopService.advance()` moves orders placed → packed (2 min) → shipped (5) → out for delivery (9) → delivered (14).
- **Payments**: online methods post to a `gateway_clearing` ledger account (test mode). Wire Razorpay order + webhook here.
- **OTP**: fixed `DEV_OTP`; MSG91 sending is a TODO in `auth.service.ts`.

## Open business decisions affecting code

Plan A per-member payout formula, what counts as "repurchase" (currently paid shopping orders + paid bookings in the calendar month), commission rates (`COMMISSION_PCT` = 15), cancellation fees. See the documentation PDF, section 23.4.
