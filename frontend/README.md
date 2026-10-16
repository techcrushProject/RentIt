# RentHub frontend

Static pages (HTML, Tailwind from a CDN, plain JavaScript, no build step) for the RentIt API in the repository root. There are three independently deployable units:

| Folder | What it is | Login page |
| --- | --- | --- |
| `./` (this folder) | Admin site: `renthub-admin-*.html` | `Onboarding/index.html` |
| `Onboarding/` | Single-page signup, login, KYC and simple owner and renter screens | `index.html` |
| `RENTHUBUSERDASH/` | Renter dashboard (`renthub-user-*.html`), owner dashboard (`RentHub/`) and a second onboarding page | `renthub-onboarding.html` |

## Configuration

Each unit has its own copy of two shared files. Keep the copies identical.

- `renthub-config.js` holds the API address. Edit `PRODUCTION_API` when the backend moves. Pages served from `localhost` or `127.0.0.1` use `http://localhost:3000/api`. The page links (`LOGIN_URL` and so on) are resolved relative to this file, so they work from any folder depth.
- `renthub-auth.js` (`window.RentHubAuth`) is the only code that touches the login token. It holds the API client, HTML escaping (`esc`), URL checks (`safeUrl`), image downscaling and signed photo uploads.

Load them in this order, before any page script: `renthub-config.js`, then `renthub-auth.js`. The admin pages also load `renthub-admin-guard.js` in `<head>`.

## Rules for page code

- Escape every server, URL or user value placed in HTML with `RentHubAuth.esc()`, and pass every `src` or `href` through `RentHubAuth.safeUrl()`. Prefer `textContent`.
- Call the API only through `RentHubAuth.api()`. Never hardcode a host, and never read or write the token in `localStorage` directly.
- Guards (`requireLogin`) only redirect for convenience. The API enforces every permission.
- Identity documents are sent to the API only, never to Cloudinary or any other third party.

## Known gaps

- The API has no bookings, payments, payouts, disputes, reviews, owner profile or notifications yet. Those owner pages run on the bundled mock JSON (`USE_MOCK_DATA = true`). The renter checkout, rental history and parts of both dashboards also show demo data.
- Most admin pages (users, rentals, payments, deposits, disputes, reviews, reports, tickets, audit logs, roles, settings) are mock screens. KYC review and equipment moderation are wired to the API.
- The login token is kept in `localStorage`. An httpOnly cookie session would be stronger but needs backend support.
- Tailwind loads from a CDN without a pinned version or integrity hash.
