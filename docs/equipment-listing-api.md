# Equipment listing API

All routes below are mounted by `server.js`.

## Owner submissions and decisions

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/equipment/create` | Create a listing in `pending` status. The request must include `name`, `description`, `category`, `owner`, `location`, and positive `pricePerDay`. Admin review fields and status are set by the server. |
| `GET` | `/equipment/owner/:ownerId` | Return only that owner's listings, including `status`, `reviewNote`, and `reviewedAt`. The owner dashboard reads the saved review decision here. |

## Admin equipment listing section

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/admin/equipment` | Return submissions for the admin listing section. Optional `?status=pending` filters the queue. |
| `GET` | `/admin/equipment/:id` | Return one submission for review, including category and images. |
| `PUT` | `/admin/equipment/:id/review` | Approve or reject a submission. JSON body: `{ "status": "approved" | "rejected", "reviewNote": "..." }`. The response includes an `ownerResponse` object; the decision and note are persisted for the owner endpoint. |

## Renter Explore equipment section

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/equipment/explore` | Return only listings where `status` is `approved` and `availability` is `true`. The existing `/equipment/getall` endpoint uses the same approved-only filter. |

New owner submissions default to `pending` and do not appear in the renter feed until an admin approves them. Rejected submissions remain visible to the owner with the review note.

This branch does not currently include authentication middleware or a user model implementation. The owner endpoint therefore accepts an owner ID in the path, and admin endpoints do not perform role checks here; connect them to the authentication/authorization middleware when that branch is integrated.
