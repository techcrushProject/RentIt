# Equipment listing API

All routes below are mounted by `server.js`.

## Owner submissions and decisions

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/equipment/create` | Owner JWT required. Create a listing in `pending` status. The request must include `name`, `description`, `category`, `location`, and positive `pricePerDay`. The owner ID comes from the token; admin review fields and status are set by the server. |
| `GET` | `/equipment/mine` | Owner JWT required. Return only the signed-in owner's listings, including `status`, `reviewNote`, and `reviewedAt`. The owner dashboard reads the saved review decision here. |

## Admin equipment listing section

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/admin/equipment` | Admin JWT required. Return submissions for the admin listing section. Optional `?status=pending` filters the queue. |
| `GET` | `/admin/equipment/:id` | Admin JWT required. Return one submission for review, including category and images. |
| `PUT` | `/admin/equipment/:id/review` | Admin JWT required. Approve or reject a submission. JSON body: `{ "status": "approved" | "rejected", "reviewNote": "..." }`. The response includes an `ownerResponse` object; the decision and note are persisted for the owner endpoint. |

## Renter Explore equipment section

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/equipment/explore` | Public feed. Return only listings where `status` is `approved` and `availability` is `true`. The existing `/equipment/getall` endpoint uses the same approved-only filter. |

New owner submissions default to `pending` and do not appear in the renter feed until an admin approves them. Rejected submissions remain visible to the owner with the review note.

Protected routes require a Bearer JWT signed with `JWT_SECRET`. Tokens must contain `id` and `role` claims, matching the auth branch's token format. Owner create/read/update/delete/upload routes require the `owner` role; admin listing and review routes require `admin`. The renter Explore feed remains public. Configure `JWT_SECRET` and `MONGO_URI` in the deployment environment.
