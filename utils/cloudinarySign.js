import { createHash } from "node:crypto";

/**
 * Cloudinary signed-upload signature: drop empty values, sort the keys
 * alphabetically, join as key=value with "&", append the API secret and take
 * the SHA-1 hex digest. Callers must not pass the parameters Cloudinary never
 * signs (file, cloud_name, resource_type, api_key).
 */
export function signParams(params, apiSecret) {
    const toSign = Object.keys(params)
        .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== "")
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join("&");
    return createHash("sha1").update(toSign + apiSecret).digest("hex");
}
