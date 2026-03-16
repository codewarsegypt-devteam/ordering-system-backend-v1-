import multer from "multer";

const ALLOWED_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) return cb(null, true);
    const err = new Error("Invalid file type. Allowed: JPEG, PNG, WebP, GIF.");
    err.statusCode = 400;
    cb(err);
  },
});

/** Up to 2 images: image1, image2 (each max 1 file). */
export const uploadItemImages = upload.fields([
  { name: "image1", maxCount: 1 },
  { name: "image2", maxCount: 1 },
]);

/** Single logo image (field name: logo). */
export const uploadLogo = upload.single("logo");
