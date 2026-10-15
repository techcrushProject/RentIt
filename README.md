# RentIt Backend

Express and MongoDB backend for RentIt, with user authentication, role-based access, KYC submission and review, and admin equipment approval.

## Requirements

- Node.js and npm
- MongoDB connection string

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env` file in the project root:

   ```env
   MONGO_URI=mongodb://127.0.0.1:27017/rentit
   JWT_SECRET=replace-with-a-long-random-secret
   PORT=3000
   ```

   Use your MongoDB connection string for `MONGO_URI`. `PORT` is optional; the server defaults to `3000`.

3. Start the server:

   ```bash
   npm start
   ```

   For development with automatic restarts:

   ```bash
   npm run dev
   ```

The API is available at `http://localhost:3000` by default. `GET /` returns a welcome message.

## Authentication

Register or log in through the auth endpoints. Login returns a JWT. Include it on protected requests as:

```http
Authorization: Bearer <token>
```

Roles used by the API are `renter`, `owner`, and `admin`. Admin endpoints require an authenticated admin user.

## API Endpoints

All endpoints are relative to the server base URL. Request and response bodies use JSON.

### Authentication (`/api/auth`)

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| `POST` | `/register` | Public | Register as a renter (default) or owner. Requires `name`, `email`, and `password`; accepts `role`, `firstName`, `lastName`, `businessName`, and `phone`. |
| `POST` | `/login` | Public | Log in with `email` and `password`; returns a JWT and user details. |
| `POST` | `/setup-admin` | Public, one-time | Create the first admin account. Requires `name`, `email`, and `password`; fails if an admin already exists. |
| `GET` | `/me` | Authenticated | Return the logged-in user's token data. |
| `PUT` | `/users/role` | Admin | Change a user's role. Requires `userId` and `role` (`renter`, `owner`, or `admin`). |
| `GET` | `/renter-only` | Renter | Example renter-only endpoint. |
| `GET` | `/owner-only` | Owner | Example owner-only endpoint. |
| `GET` | `/admin-only` | Admin | Example admin-only endpoint. |

### KYC (`/api/kyc`)

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/me` | Authenticated | Get the current user's KYC record. |
| `POST` | `/` | Authenticated renter or owner | Submit KYC. Requires `documentType`, `documentNumber`, JPEG/PNG/WebP data URLs in `documentUrl` and `selfieUrl`; optional `address`. |

### Equipment (`/api/equipment`)

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| `POST` | `/` | Authenticated owner | Create a pending equipment listing. Requires `title` and positive `price`; accepts `description`, `category`, `condition`, `location`, `specs`, and an optional `image` data URL. |

### Admin (`/api/admin`)

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/kyc` | Admin | List KYC submissions. |
| `PUT` | `/verify-user/:id` | Admin | Set KYC status to `verified`, `rejected`, or `resubmit`. Optional body fields: `status` (defaults to `verified`) and `rejectionReason`. |
| `PUT` | `/equipment/:id/approve` | Admin | Approve an equipment listing. |

The onboarding page defaults to `http://localhost:3000/api`. Start the API from this folder with `npm start`, then open `Onboarding/index.html` from the frontend workspace. KYC images are currently stored as data URLs in MongoDB to support local onboarding without a cloud-storage dependency; use private object storage with access controls before production deployment.

## Project Structure

- `server.js` - Express app setup and server startup
- `config/` - MongoDB connection
- `Routes/` - API route definitions
- `Controllers/` - Request handlers
- `Middleware/` - Authentication and role authorization
- `Models/` - Mongoose models
