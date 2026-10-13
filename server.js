
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR =
  process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
const META_DIR = path.join(UPLOAD_DIR, ".metadata");
const PUBLIC_DIR = path.join(__dirname, "public");

const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1 GB

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(META_DIR, { recursive: true });

app.disable("x-powered-by");

// Optional authentication. Set BOTH environment variables to enable it.
const SHARE_USER = process.env.SHARE_USER;
const SHARE_PASSWORD = process.env.SHARE_PASSWORD;

if (Boolean(SHARE_USER) !== Boolean(SHARE_PASSWORD)) {
  throw new Error(
    "Set both SHARE_USER and SHARE_PASSWORD, or leave both unset."
  );
}

if (SHARE_USER && SHARE_PASSWORD) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || "";
    const match = header.match(/^Basic\s+(.+)$/i);

    if (!match) {
      res.set("WWW-Authenticate", 'Basic realm="WLAN Share"');
      return res.status(401).send("Authentication required.");
    }

    let decoded;

    try {
      decoded = Buffer.from(match[1], "base64").toString("utf8");
    } catch {
      return res.status(401).send("Invalid credentials.");
    }

    const separator = decoded.indexOf(":");

    if (separator < 0) {
      return res.status(401).send("Invalid credentials.");
    }

    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);

    if (username !== SHARE_USER || password !== SHARE_PASSWORD) {
      res.set("WWW-Authenticate", 'Basic realm="WLAN Share"');
      return res.status(401).send("Invalid credentials.");
    }

    next();
  });
}

app.use(express.static(PUBLIC_DIR));

function metadataPath(id) {
  return path.join(META_DIR, `${id}.json`);
}

function validId(id) {
  return /^\d+-[a-f0-9]{16}(?:\.[a-zA-Z0-9]{1,20})?$/.test(id);
}

function getLanAddresses() {
  const addresses = [];

  for (const [interfaceName, interfaces] of Object.entries(
    os.networkInterfaces()
  )) {
    for (const item of interfaces || []) {
      if (item.family === "IPv4" && !item.internal) {
        addresses.push({
          interfaceName,
          address: item.address,
        });
      }
    }
  }

  return addresses;
}

function readMetadata() {
  return fs
    .readdirSync(UPLOAD_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && validId(entry.name))
    .map((entry) => {
      const fullPath = path.join(UPLOAD_DIR, entry.name);
      const stat = fs.statSync(fullPath);

      let metadata = {};

      try {
        metadata = JSON.parse(
          fs.readFileSync(metadataPath(entry.name), "utf8")
        );
      } catch {
        // Use fallback values if metadata is unavailable.
      }

      return {
        id: entry.name,
        name: metadata.originalName || entry.name,
        size: stat.size,
        type: metadata.mimeType || "application/octet-stream",
        uploadedAt: metadata.uploadedAt || stat.mtime.toISOString(),
      };
    })
    .sort(
      (a, b) =>
        new Date(b.uploadedAt).getTime() -
        new Date(a.uploadedAt).getTime()
    );
}

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, UPLOAD_DIR);
  },

  filename: (_req, file, callback) => {
    const extension = path
      .extname(file.originalname)
      .replace(/[^a-zA-Z0-9.]/g, "")
      .slice(0, 20);

    const id =
      `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${extension}`;

    callback(null, id);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
  },
});

// Server information
app.get("/api/info", (_req, res) => {
  res.json({
    name: "WLAN Share",
    port: PORT,
    addresses: getLanAddresses(),
    maxFileSize: MAX_FILE_SIZE,
    authenticationEnabled: Boolean(SHARE_USER && SHARE_PASSWORD),
    note: "Files are stored on the server, not in cloud storage managed by this application.",
  });
});

// List shared files
app.get("/api/files", (_req, res) => {
  try {
    res.json({ files: readMetadata() });
  } catch (error) {
    console.error("List files error:", error);
    res.status(500).json({ error: "Unable to list files." });
  }
});

// Upload a file
app.post("/api/upload", (req, res) => {
  upload.single("file")(req, res, (error) => {
    if (error) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          error: "File exceeds the 1 GB upload limit.",
        });
      }

      console.error("Upload error:", error);
      return res.status(400).json({
        error: error.message || "Upload failed.",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Choose a file first.",
      });
    }

    const metadata = {
      originalName: path.basename(req.file.originalname || "download"),
      mimeType: req.file.mimetype || "application/octet-stream",
      uploadedAt: new Date().toISOString(),
    };

    try {
      fs.writeFileSync(
        metadataPath(req.file.filename),
        JSON.stringify(metadata, null, 2)
      );

      res.status(201).json({
        message: "File uploaded successfully.",
        file: {
          id: req.file.filename,
          name: metadata.originalName,
          size: req.file.size,
          type: metadata.mimeType,
          uploadedAt: metadata.uploadedAt,
        },
      });
    } catch (writeError) {
      console.error("Metadata error:", writeError);

      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename));
      } catch {}

      res.status(500).json({
        error: "Could not save file metadata.",
      });
    }
  });
});

// Download a file
app.get("/api/files/:id/download", (req, res) => {
  const id = req.params.id;

  if (!validId(id)) {
    return res.status(400).json({ error: "Invalid file ID." });
  }

  const fullPath = path.join(UPLOAD_DIR, id);

  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return res.status(404).json({ error: "File not found." });
  }

  let originalName = id;

  try {
    const metadata = JSON.parse(
      fs.readFileSync(metadataPath(id), "utf8")
    );
    originalName = path.basename(metadata.originalName || id);
  } catch {}

  res.download(fullPath, originalName, (error) => {
    if (error && !res.headersSent) {
      console.error("Download error:", error);
      res.status(500).json({ error: "Download failed." });
    }
  });
});

// Delete a file
app.delete("/api/files/:id", (req, res) => {
  const id = req.params.id;

  if (!validId(id)) {
    return res.status(400).json({ error: "Invalid file ID." });
  }

  const fullPath = path.join(UPLOAD_DIR, id);

  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return res.status(404).json({ error: "File not found." });
  }

  try {
    fs.unlinkSync(fullPath);

    try {
      fs.unlinkSync(metadataPath(id));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    res.json({ message: "File deleted successfully." });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({ error: "Unable to delete file." });
  }
});

// Serve the frontend
app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Start the server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`WLAN Share running on port ${PORT}`);
  console.log(`Local URL: http://localhost:${PORT}`);
  console.log(`Storage: ${UPLOAD_DIR}`);
  console.log(
    `Authentication: ${SHARE_USER && SHARE_PASSWORD ? "enabled" : "disabled"}`
  );

  if (!process.env.RENDER) {
    for (const item of getLanAddresses()) {
      console.log(
        `Wi-Fi URL: http://${item.address}:${PORT}`
      );
    }
  }
});