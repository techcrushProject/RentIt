
/* =========================================================
   RentHUB - kyc.js
   Collects required identity documents.
   No OCR, face detection, or face matching.
   ========================================================= */

function verifyIdentity(idFile, selfieFile) {
  // Both documents are required.
  if (!idFile || !selfieFile) {
    return {
      ok: false,
      message: "Please upload both your government ID and selfie."
    };
  }

  // Confirm that both selected files are JPEG, PNG or WebP images, the types the API accepts.
  var allowed = ["image/jpeg", "image/png", "image/webp"];

  if (
    allowed.indexOf(idFile.type) === -1 ||
    allowed.indexOf(selfieFile.type) === -1
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