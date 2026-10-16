# RentIt Backend

Express 5 and MongoDB API for RentIt (the RentHub marketplace): accounts with renter, owner and admin roles, identity verification (KYC) reviewed by admins, and equipment listings that go live only after admin approval.

## Quick start

Requirements: Node.js 22+, npm, and either Docker or any MongoDB 6+ connection string.

```bash
cp .env.example .env          # then replace every CHANGE_ME value
npm ci
docker compose up -d mongo    # local MongoDB with auth, bound to 127.0.0.1 only
docker compose ps             # wait until it reports "healthy"
npm run dev                   # or: npm start
```

Generate secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

The server validates its configuration at startup and exits with a clear message if anything is missing or unsafe. `GET /health` reports `200 {"status":"ok","db":"up"}` once MongoDB is connected.

### Creating the first admin

Admins can never self-register. Set `SETUP_ADMIN_TOKEN` in `.env`, start the server, then call the one-time endpoint:

```bash
curl -X POST http://localhost:3000/api/auth/setup-admin \
  -H "Content-Type: application/json" \
  -H "X-Setup-Token: $SETUP_ADMIN_TOKEN" \
  -d '{"name":"Ops Admin","email":"admin@example.com","password":"a-long-Passw0rd"}'
```

It works exactly once, even under concurrent requests. Afterwards remove `SETUP_ADMIN_TOKEN` (the endpoint then answers 404). Further admins are promoted by an existing admin with `PUT /api/auth/users/role`.

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `MONGO_URI` | yes | URL-encode special characters in the password. |
| `JWT_SECRET` | yes | At least 32 random characters. |
| `JWT_EXPIRES_IN` | no | Default `1d`. Format `15m`, `12h`, `1d`. |
| `CORS_ORIGINS` | in production | Comma-separated exact frontend origins. `*` is refused. |
| `TRUST_PROXY` | in production | Proxy hops in front of the API: `1` behind Render's proxy, `0` when clients connect directly. Defaults to `0` outside production. A wrong value lets clients spoof their IP and dodge rate limits. |
| `SETUP_ADMIN_TOKEN` | no | Enables the first-admin endpoint. At least 24 characters. |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | no | All three or none. Enables signed equipment photo uploads. |
| `NODE_ENV` | no | `development` (default), `production` or `test`. Any other value is refused. |
| `PORT` | no | Default `3000`. |

Placeholder values such as `CHANGE_ME` in `MONGO_URI`, `JWT_SECRET` or `SETUP_ADMIN_TOKEN` are refused in every environment. The Docker init script likewise refuses database passwords shorter than 16 characters or still set to a placeholder.

The `MONGO_ROOT_*`, `MONGO_APP_*`, `MONGO_DB` and `MONGO_PORT` variables are read only by `docker-compose.yml`.

## Security model

- **Sessions.** Login returns a JWT (HS256). Send it as `Authorization: Bearer <token>`. On every request the server re-reads the user, so the role always comes from the database and deleted users lose access at once. Logout and role changes bump a per-user token version, which revokes every older token for that user. There is no password-change or reset endpoint yet.
- **Passwords.** bcrypt cost 12. At least 8 characters, at most 72 bytes, with a letter and a number. Unknown emails take as long to reject as wrong passwords.
- **Roles.** Registration creates `renter` or `owner` only.
- **KYC documents** stay in the database (never on a public CDN), are excluded from every query by default, are never listed, and are served one at a time to admins only, with `no-store` and a sandbox CSP.
- **Listings** are always created `pending`. Only approved, available listings are public. Editing an approved listing sends it back to review, and an approval only applies to the version the admin was shown. An owner may have at most 10 listings awaiting review and 100 in total. Public responses never include an owner's email or phone.
- **Images** must be real JPEG, PNG or WebP files (checked by file signature, not just the declared type). Equipment photos may also be Cloudinary URLs, but only from the uploader's own folder.
- **Input** is validated as strings, numbers and ObjectIds before it reaches MongoDB, which blocks NoSQL operator injection. Search text is regex-escaped.
- **HTTP hardening.** helmet headers, a CORS allowlist, JSON bodies capped at 100kb (8mb only for signed-in POST, PUT and PATCH requests to KYC and equipment), query keys containing `[`, `]` or `$` refused, `Cache-Control: no-store` on auth, KYC, admin and upload responses, and rate limits per IP. Limits are 300 requests per 15 minutes overall, 20 login or registration attempts per 15 minutes, 5 setup-admin calls per hour and 10 KYC submissions per hour. Unexpected errors return a generic 500, and the server logs never contain request bodies or tokens.

Rate-limit counters live in process memory. Running several instances needs a shared store such as Redis.

## API reference

Base path `/api`. Bodies are JSON. Errors are `{"message": "..."}`. "Owner", "Renter" and "Admin" mean the authenticated user's role.

### Auth (`/api/auth`)

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| POST | `/register` | Public | `name`, `email`, `password`; optional `role` (`renter` default, or `owner`), `firstName`, `lastName`, `businessName`, `phone`. 201, or 409 when the email exists. |
| POST | `/login` | Public | `email`, `password`. Returns `token` and `user`. |
| POST | `/logout` | Signed in | Revokes all of the caller's tokens. |
| GET | `/me` | Signed in | Current profile including `kycStatus` and `isVerified`. |
| PUT | `/users/role` | Admin | `userId`, `role`. Admins cannot change their own role or demote the last admin. |
| POST | `/setup-admin` | `X-Setup-Token` | One-time first admin. See above. |
| GET | `/renter-only`, `/owner-only`, `/admin-only` | Matching role | Examples. |

### KYC (`/api/kyc`)

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| POST | `/` | Renter or Owner | `documentType` (`NIN`, `Voter's card`, `Driver's licence`, `International passport`), `documentNumber`, `documentUrl` and `selfieUrl` as JPEG/PNG/WebP data URLs of at most 2MB each, optional `address`. 409 while a submission is under review or verified. |
| GET | `/me` | Signed in | Status, rejection reason and submission metadata. 404 `KYC record not found` before the first submission. Never returns images or the document number. |

### Admin (`/api/admin`, Admin only)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/kyc` | Submissions. Query `status` (`under_review`, `verified`, `rejected`, `resubmit`, `all`), `q` (name or email), `page`, `limit` (max 100). Items carry `documentPath` and `selfiePath` instead of image data. |
| GET | `/kyc/:id/document`, `/kyc/:id/selfie` | The image bytes. Fetch with the admin token and display through a blob URL. |
| PUT | `/verify-user/:id` | `status` is required (`verified`, `rejected`, `resubmit`); there is no default. `rejectionReason` is required for the last two. |
| GET | `/equipment` | Listings to review. Query `status` (`pending` default, `approved`, `rejected`, `all`), `page`, `limit`. |
| PUT | `/equipment/:id/approve` | Publish a listing. Optional `expectedUpdatedAt` (the listing's `updatedAt` as displayed): if the owner changed the listing since, the answer is 409 and nothing is published. |
| PUT | `/equipment/:id/reject` | `reason` required. |
| PUT | `/equipment/:id/review` | `status` (`approved` or `rejected`) and `reason`. |

### Equipment (`/api/equipment`)

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| GET | `/` | Public | Approved, available listings. Query `q`, `category` (name or slug), `location`, `minPrice`, `maxPrice`, `page` (max 10000), `limit` (max 100). List items carry `images` with only the first photo, plus `imageCount`. |
| GET | `/mine` | Owner | The caller's listings in every status. |
| GET | `/:id` | Public if approved, else its owner or an admin | Full listing with every image. |
| POST | `/` | Owner | `title`, `price` (per day, NGN), optional `description`, `rentalDeposit`, `category`, `condition`, `location`, `specs` (up to 20), `images` (up to 6), `availability`. Always created `pending`. 429 when 10 of the owner's listings already await review, 409 at 100 listings. |
| PATCH | `/:id` | The listing's owner | Same fields. Content edits send an approved or rejected listing back to `pending`. Toggling `availability` alone does not. |
| DELETE | `/:id` | The listing's owner, or an Admin | |

`images` entries are either Cloudinary URLs from `/api/uploads/sign` (only from the uploader's own folder) or JPEG/PNG/WebP data URLs of at most 900KB each and 3MB in total per listing.

The routes are also mounted at `/equipment` with the legacy aliases `/getall`, `/getone/:id`, `/create`, `/update/:id` and `/delete/:id` for older frontend pages. They apply exactly the same rules.

### Categories and uploads

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| GET | `/api/categories` (also `/category/getall`) | Public | The fixed catalogue: Equipments, Power Tools, Properties, Camera & Photography, Event & Party Items, Electronics, Furnitures, More. |
| POST | `/api/uploads/sign` | Owner or Admin | Body `{"purpose":"equipment"}`. Returns signed parameters for a direct Cloudinary upload into `rentit/equipment/<userId>`. 503 when Cloudinary is not configured. |

## Testing

```bash
npm run test:unit                                              # no database needed
TEST_MONGO_URI=mongodb://127.0.0.1:27017/rentit_test npm run test:integration
```

Integration tests drop the database they point at, and refuse names such as `rentit` or anything containing `prod`. CI (`.github/workflows/ci.yml`) runs both suites against a MongoDB service container and fails on high-severity `npm audit` findings.

## Project structure

- `server.js` loads configuration, connects to MongoDB, starts the HTTP server and shuts down gracefully.
- `app.js` builds the Express app: security middleware, body limits, rate limits and routes.
- `config/` holds environment validation, the database connection and the category catalogue.
- `Routes/`, `Controllers/`, `Middleware/` and `Models/` hold the HTTP layer, the handlers, auth and error handling, and the Mongoose schemas.
- `utils/` has input validation, HTTP errors, JWT helpers and Cloudinary signing.
- `docker-compose.yml` and `docker/mongo/init/` set up local MongoDB.
- `tests/unit` and `tests/integration` hold the test suites.
- `frontend/` holds the RentHub static pages (admin site, onboarding, renter and owner dashboards). See `frontend/README.md`.

## Security follow-ups that need a person

1. **Rotate the MongoDB Atlas password** for the `Cohort8_db` cluster user. It was committed in plain text to `index.js` on four branches of this public repository (`feature/backend-initial-setup`, `feature/damage-claims`, `feature/equipment-management`, `fix/equipment-status-filter`). Treat it as compromised whatever happens to the branches.
2. **Purge it from history** with `git filter-repo` or BFG, then force-push and have everyone re-clone. Rotation matters more than the purge, because forks and caches keep old commits.
3. **Turn on GitHub secret scanning and push protection** for the organisation.
4. **Set production configuration on the host** (Render dashboard), never in the repository: `NODE_ENV=production`, `JWT_SECRET`, `MONGO_URI`, `CORS_ORIGINS` and `TRUST_PROXY=1`. The server refuses to start in production without them.
