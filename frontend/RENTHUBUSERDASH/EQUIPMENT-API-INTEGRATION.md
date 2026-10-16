# Equipment API integration

All pages talk to the single RentIt API through `RentHubAuth.api()`. The base URL comes from `renthub-config.js`, and the routes are documented in the repository README.

| Page script | Calls |
| --- | --- |
| `RentHub/Equipment/Equipment.js`, `RentHub/owner-dashboard/owner_dashboard.js` | `GET /equipment/mine` (the owner's listings in every status) |
| `RentHub/Equipment/add-equipment.js` | `GET /categories` (falls back to the bundled list) |
| `RentHub/Equipment/listing-preview.js` | photos through `RentHubAuth.uploadEquipmentImage`, then `POST /equipment` |
| `RentHub/Equipment/equipment-details.js` | `GET /equipment/:id`, `PATCH /equipment/:id`, `DELETE /equipment/:id` |
| `renthub-user-equipment-data.js` | `GET /equipment?limit=100` (public, approved and available only) |

Every write requires the owner's login token; the API checks ownership on each request. New and edited listings are `pending` until an admin approves them. Photos go through a server-signed Cloudinary upload when the API has Cloudinary configured, and otherwise fall back to small inline JPEGs, which the API caps at 900KB each and 3MB per listing.
