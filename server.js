const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1 GB per file

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(express.static(PUBLIC_DIR));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    // Keep a safe generated disk name; preserve the original name in metadata.
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${path.extname(file.originalname).slice(0, 20)}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (_req, file, cb) => {
    // Browsers may report an empty MIME type; the original filename is not used as a path.
    cb(null, true);
  }
});

function readMetadata() {
  const entries = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const fullPath = path.join(UPLOAD_DIR, entry.name);
      const stat = fs.statSync(fullPath);
      const metaPath = `${fullPath}.json`;
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch {}
      return {
        id: entry.name,
        name: meta.originalName || entry.name,
        size: stat.size,
        type: meta.mimeType || "application/octet-stream",
        uploadedAt: meta.uploadedAt || stat.mtime.toISOString()
      };
    });
  return entries.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

function getLanAddresses() {
  const addresses = [];
  for (const [interfaceName, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) {
        addresses.push({ interfaceName, address: item.address });
      }
    }
  }
  return addresses;
}

app.get("/api/info", (_req, res) => {
  res.json({
    name: "WLAN Share",
    port: PORT,
    addresses: getLanAddresses(),
    maxFileSize: MAX_FILE_SIZE,
    note: "Devices must be on the same reachable local network. No cloud service is used."
  });
});

app.get("/api/files", (_req, res) => {
  res.json({ files: readMetadata() });
});

app.post("/api/upload", (req, res) => {
  upload.single("file")(req, res, err => {
    if (err) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({
        error: err.code === "LIMIT_FILE_SIZE"
          ? "File exceeds the 1 GB upload limit."
          : (err.message || "Upload failed.")
      });
    }
    if (!req.file) return res.status(400).json({ error: "Choose a file first." });

    const fullPath = path.join(UPLOAD_DIR, req.file.filename);
    const metadata = {
      originalName: path.basename(req.file.originalname || "download"),
      mimeType: req.file.mimetype || "application/octet-stream",
      uploadedAt: new Date().toISOString()
    };
    fs.writeFileSync(`${fullPath}.json`, JSON.stringify(metadata, null, 2));
    res.status(201).json({
      message: "File uploaded successfully.",
      file: {
        id: req.file.filename,
        name: metadata.originalName,
        size: req.file.size,
        type: metadata.mimeType,
        uploadedAt: metadata.uploadedAt
      }
    });
  });
});

app.get("/api/files/:id/download", (req, res) => {
  const id = path.basename(req.params.id);
  const fullPath = path.join(UPLOAD_DIR, id);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return res.status(404).json({ error: "File not found." });
  }
  let originalName = id;
  try {
    const meta = JSON.parse(fs.readFileSync(`${fullPath}.json`, "utf8"));
    originalName = path.basename(meta.originalName || id);
  } catch {}
  res.download(fullPath, originalName);
});

app.delete("/api/files/:id", (req, res) => {
  const id = path.basename(req.params.id);
  const fullPath = path.join(UPLOAD_DIR, id);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return res.status(404).json({ error: "File not found." });
  }
  fs.unlinkSync(fullPath);
  try { fs.unlinkSync(`${fullPath}.json`); } catch {}
  res.json({ message: "File deleted." });
});

app.get("*", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\nWLAN Share is running on port ${PORT}`);
  console.log(`On this computer: http://localhost:${PORT}`);
  for (const item of getLanAddresses()) {
    console.log(`On the same Wi-Fi: http://${item.address}:${PORT} (${item.interfaceName})`);
  }
  console.log("\nKeep this terminal open while sharing files.\n");
});
