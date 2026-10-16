
/* =========================================================
  RentHUB identity document checks
   Collects required identity documents.
   No OCR, face detection, or face matching.
   The files are only ever sent to the RentHub API
   (see finishIdentity in renthub-onboarding-flow.js).
   ========================================================= */

// The browser re-encodes the photos before sending them, which supports these types.
var IDENTITY_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

function verifyIdentity(idFile, selfieFile) {
  // Both documents are required.
  if (!idFile || !selfieFile) {
    return {
      ok: false,
      message: "Please upload both your government ID and selfie."
    };
  }

  // Confirm that both selected files are JPEG, PNG or WebP images.
  if (
    IDENTITY_IMAGE_TYPES.indexOf(idFile.type) === -1 ||
    IDENTITY_IMAGE_TYPES.indexOf(selfieFile.type) === -1
  ) {
    return {
      ok: false,
      message: "Please upload JPEG, PNG or WebP images for both documents."
    };
  }

  // No automatic identity verification is performed.
  return {
    ok: true,
    message: "Your identity documents have been submitted."
  };
}