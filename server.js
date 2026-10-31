const express = require("express");
const mariadb = require("mariadb");
const crypto = require("crypto");
const path = require("path");
const QRCode = require("qrcode");
const scrypt = require("crypto").scrypt;
const { promisify } = require("util");
const scryptAsync = promisify(scrypt);

const app = express();
const port = Number(process.env.PORT) || 3110;
const pool = mariadb.createPool({
  host: "10.200.210.117",
  port: 3306,
  user: "std10",
  password: "std10",
  database: "db_std10",
  connectionLimit: 5,
  charset: "utf8mb4"
});

const sessions = new Map();
const sessionLifetimeMs = 8 * 60 * 60 * 1000;
const activeBookingStatuses = ["confirmed"];

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));
app.get("/profile", (req, res) => res.sendFile("index.html", { root: path.join(__dirname, "public") }));

async function ensureSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, email VARCHAR(254) NOT NULL, password_hash VARCHAR(255) NOT NULL, role ENUM('shop','admin') NOT NULL DEFAULT 'shop', is_active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (id), UNIQUE KEY uq_users_email (email), KEY idx_users_role_active (role,is_active)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(150) NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data MEDIUMTEXT NULL",
    `CREATE TABLE IF NOT EXISTS shops (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, user_id BIGINT UNSIGNED NOT NULL, name VARCHAR(150) NOT NULL, category VARCHAR(100) NOT NULL, description TEXT NULL, contact_info VARCHAR(255) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (id), UNIQUE KEY uq_shops_user_id (user_id), KEY idx_shops_category (category), CONSTRAINT fk_shops_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS markets (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, name VARCHAR(150) NOT NULL, description TEXT NULL, location VARCHAR(255) NOT NULL, is_active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (id), KEY idx_markets_active_name (is_active,name)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS market_sessions (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, market_id BIGINT UNSIGNED NOT NULL, name VARCHAR(100) NOT NULL, starts_at DATETIME NOT NULL, ends_at DATETIME NOT NULL, booking_open TINYINT(1) NOT NULL DEFAULT 0, map_token CHAR(36) NOT NULL, is_published TINYINT(1) NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (id), UNIQUE KEY uq_market_sessions_map_token (map_token), KEY idx_sessions_market_start (market_id,starts_at), KEY idx_sessions_public (is_published,starts_at), CONSTRAINT fk_sessions_market FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE RESTRICT ON UPDATE RESTRICT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS market_conversations (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, market_id BIGINT UNSIGNED NOT NULL, shop_user_id BIGINT UNSIGNED NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (id), UNIQUE KEY uq_market_conversation_shop (market_id,shop_user_id), KEY idx_market_conversations_updated (market_id,updated_at), CONSTRAINT fk_market_conversations_market FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE RESTRICT ON UPDATE RESTRICT, CONSTRAINT fk_market_conversations_user FOREIGN KEY (shop_user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS market_messages (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, conversation_id BIGINT UNSIGNED NOT NULL, sender_user_id BIGINT UNSIGNED NOT NULL, sender_role ENUM('shop','admin') NOT NULL, message TEXT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id), KEY idx_market_messages_conversation (conversation_id,id), CONSTRAINT fk_market_messages_conversation FOREIGN KEY (conversation_id) REFERENCES market_conversations(id) ON DELETE RESTRICT ON UPDATE RESTRICT, CONSTRAINT fk_market_messages_user FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS market_reviews (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, market_id BIGINT UNSIGNED NOT NULL, user_id BIGINT UNSIGNED NOT NULL, rating TINYINT UNSIGNED NOT NULL, comment VARCHAR(1000) NOT NULL DEFAULT '', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (id), UNIQUE KEY uq_market_review_user (market_id,user_id), KEY idx_market_reviews_market_created (market_id,created_at), CONSTRAINT fk_market_reviews_market FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE RESTRICT ON UPDATE RESTRICT, CONSTRAINT fk_market_reviews_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT, CONSTRAINT chk_market_review_rating CHECK (rating BETWEEN 1 AND 5)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS booths (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, market_id BIGINT UNSIGNED NOT NULL, booth_code VARCHAR(30) NOT NULL, map_x DECIMAL(7,4) NULL, map_y DECIMAL(7,4) NULL, is_active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (id), UNIQUE KEY uq_booths_market_code (market_id,booth_code), KEY idx_booths_market_active (market_id,is_active), CONSTRAINT fk_booths_market FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE RESTRICT ON UPDATE RESTRICT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS bookings (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, session_id BIGINT UNSIGNED NOT NULL, booth_id BIGINT UNSIGNED NOT NULL, shop_id BIGINT UNSIGNED NOT NULL, status ENUM('confirmed','cancelled') NOT NULL DEFAULT 'confirmed', booked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, cancelled_at DATETIME NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, active_booth_id BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status = 'confirmed' THEN booth_id ELSE NULL END) STORED, active_shop_id BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status = 'confirmed' THEN shop_id ELSE NULL END) STORED, PRIMARY KEY (id), UNIQUE KEY uq_bookings_active_booth (session_id,active_booth_id), UNIQUE KEY uq_bookings_active_shop (session_id,active_shop_id), KEY idx_bookings_shop_session_status (shop_id,session_id,status), CONSTRAINT fk_bookings_session FOREIGN KEY (session_id) REFERENCES market_sessions(id) ON DELETE RESTRICT ON UPDATE RESTRICT, CONSTRAINT fk_bookings_booth FOREIGN KEY (booth_id) REFERENCES booths(id) ON DELETE RESTRICT ON UPDATE RESTRICT, CONSTRAINT fk_bookings_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE RESTRICT ON UPDATE RESTRICT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  ];
  let connection;
  try {
    connection = await pool.getConnection();
    for (const statement of statements) await connection.query(statement);
    console.log("Database schema verified/created without dropping existing tables.");
  } finally {
    if (connection) connection.release();
  }
}

function sendError(res, status, code, message, fields) {
  const error = { code, message };
  if (fields) error.fields = fields;
  return res.status(status).json({ error });
}

function parsePagination(query) {
  const page = Number.parseInt(query.page || "1", 10);
  const limit = Number.parseInt(query.limit || "20", 10);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) return null;
  return { page, limit, offset: (page - 1) * limit };
}

function getBangkokDateTime() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function validateText(value, maxLength, required) {
  if (typeof value !== "string") return required ? "กรุณากรอกข้อมูล" : null;
  const text = value.trim();
  if (required && !text) return "กรุณากรอกข้อมูล";
  if (text.length > maxLength) return `ต้องมีความยาวไม่เกิน ${maxLength} ตัวอักษร`;
  return null;
}

function validateAvatarData(value) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 700000) return "รูปโปรไฟล์ต้องมีขนาดไม่เกิน 512 KB";
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return "รองรับรูปโปรไฟล์ PNG, JPEG หรือ WebP เท่านั้น";
  const image = Buffer.from(match[2], "base64");
  if (image.length > 512 * 1024) return "รูปโปรไฟล์ต้องมีขนาดไม่เกิน 512 KB";
  const validSignature = match[1] === "png"
    ? image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : match[1] === "jpeg"
      ? image.length >= 3 && image[0] === 255 && image[1] === 216 && image[2] === 255
      : image.length >= 12 && image.toString("ascii", 0, 4) === "RIFF" && image.toString("ascii", 8, 12) === "WEBP";
  return validSignature ? null : "ไฟล์รูปโปรไฟล์ไม่ถูกต้อง";
}

function getSession(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\\s*)market_session=([a-f0-9]{64})/);
  if (!match) return null;
  const session = sessions.get(match[1]);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(match[1]);
    return null;
  }
  session.expiresAt = Date.now() + sessionLifetimeMs;
  return session;
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return sendError(res, 401, "UNAUTHENTICATED", "กรุณาเข้าสู่ระบบก่อนใช้งาน");
  req.auth = session;
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.auth || req.auth.role !== role) return sendError(res, 403, "FORBIDDEN", "คุณไม่มีสิทธิ์ใช้งานส่วนนี้");
    next();
  };
}

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `market_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(sessionLifetimeMs / 1000)}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "market_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

async function hashPassword(password, salt) {
  const actualSalt = salt || crypto.randomBytes(16);
  const hash = await scryptAsync(password, actualSalt, 64);
  return `${actualSalt.toString("hex")}:${hash.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== "string" || !stored.includes(":")) return false;
  const [saltHex, hashHex] = stored.split(":");
  try {
    const candidate = await scryptAsync(password, Buffer.from(saltHex, "hex"), 64);
    const expected = Buffer.from(hashHex, "hex");
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch (error) {
    return false;
  }
}

async function getShopId(connection, userId) {
  const rows = await connection.query("SELECT id FROM shops WHERE user_id = ? LIMIT 1", [userId]);
  return rows.length ? Number(rows[0].id) : null;
}

app.get("/api/health", async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Database health check failed:", error.message);
    sendError(res, 503, "DATABASE_UNAVAILABLE", "ระบบฐานข้อมูลยังไม่พร้อมใช้งาน");
  } finally {
    if (connection) connection.release();
  }
});

app.post("/api/auth/register", async (req, res) => {
  const { email, password, shopName, category, description = "", contactInfo = "" } = req.body || {};
  const fields = {};
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) fields.email = "กรุณากรอกอีเมลที่ถูกต้อง";
  if (typeof password !== "string" || password.length < 8 || password.length > 200) fields.password = "รหัสผ่านต้องมีความยาว 8-200 ตัวอักษร";
  for (const [key, value, max] of [["shopName", shopName, 150], ["category", category, 100]]) {
    const issue = validateText(value, max, true);
    if (issue) fields[key] = issue;
  }
  for (const [key, value, max] of [["description", description, 5000], ["contactInfo", contactInfo, 255]]) {
    const issue = validateText(value, max, false);
    if (issue) fields[key] = issue;
  }
  if (Object.keys(fields).length) return sendError(res, 400, "VALIDATION_ERROR", "กรุณาตรวจสอบข้อมูลที่กรอก", fields);

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const passwordHash = await hashPassword(password);
    const userResult = await connection.query(
      "INSERT INTO users (email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, 'shop', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
      [email.trim().toLowerCase(), passwordHash]
    );
    const shopResult = await connection.query(
      "INSERT INTO shops (user_id, name, category, description, contact_info, created_at, updated_at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
      [userResult.insertId, shopName.trim(), category.trim(), description.trim(), contactInfo.trim()]
    );
    await connection.commit();
    res.status(201).json({ user: { id: Number(userResult.insertId), email: email.trim().toLowerCase(), role: "shop" }, shop: { id: Number(shopResult.insertId), name: shopName.trim(), category: category.trim(), description: description.trim(), contactInfo: contactInfo.trim() } });
  } catch (error) {
    if (connection) await connection.rollback();
    if (error.code === "ER_DUP_ENTRY") return sendError(res, 409, "EMAIL_EXISTS", "ไม่สามารถใช้ข้อมูลนี้สมัครได้");
    console.error("Registration failed:", error.message);
    sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถสมัครสมาชิกได้ในขณะนี้");
  } finally {
    if (connection) connection.release();
  }
});

app.post("/api/auth/login", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!email || !password) return sendError(res, 400, "VALIDATION_ERROR", "กรุณากรอกอีเมลและรหัสผ่าน");
  let connection;
  try {
    connection = await pool.getConnection();
    const rows = await connection.query("SELECT id, email, password_hash, role, is_active FROM users WHERE email = ? LIMIT 1", [email]);
    if (!rows.length || !rows[0].is_active || !(await verifyPassword(password, rows[0].password_hash))) return sendError(res, 401, "INVALID_CREDENTIALS", "อีเมลหรือรหัสผ่านไม่ถูกต้อง");
    const user = rows[0];
    const token = crypto.randomBytes(32).toString("hex");
    const shopId = user.role === "shop" ? await getShopId(connection, user.id) : null;
    sessions.set(token, { userId: Number(user.id), shopId, role: user.role, expiresAt: Date.now() + sessionLifetimeMs });
    setSessionCookie(res, token);
    res.set("Cache-Control", "no-store");
    res.json({ user: { id: Number(user.id), email: user.email, role: user.role }, shopId });
  } catch (error) {
    console.error("Login failed:", error.message);
    sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถเข้าสู่ระบบได้ในขณะนี้");
  } finally {
    if (connection) connection.release();
  }
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\\s*)market_session=([a-f0-9]{64})/);
  if (match) sessions.delete(match[1]);
  clearSessionCookie(res);
  res.status(204).end();
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const users = await connection.query("SELECT id, email, role, display_name AS displayName, avatar_data AS avatarData FROM users WHERE id = ? AND is_active = 1", [req.auth.userId]);
    if (!users.length) return sendError(res, 401, "UNAUTHENTICATED", "กรุณาเข้าสู่ระบบอีกครั้ง");
    let shop = null;
    if (users[0].role === "shop") {
      const shops = await connection.query("SELECT id, name, category, description, contact_info AS contactInfo FROM shops WHERE user_id = ?", [req.auth.userId]);
      shop = shops.length ? { ...shops[0], id: String(shops[0].id) } : null;
    }
    const fallbackName = shop?.name || users[0].email.split("@")[0];
    res.set("Cache-Control", "no-store");
    res.json({
      user: {
        id: Number(users[0].id),
        email: users[0].email,
        role: users[0].role,
        displayName: users[0].displayName || fallbackName,
        avatarData: users[0].avatarData
      },
      shop
    });
  } catch (error) {
    console.error("Session check failed:", error.message);
    sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถตรวจสอบบัญชีได้");
  } finally {
    if (connection) connection.release();
  }
});

app.patch("/api/profile", requireAuth, async (req, res) => {
  const { displayName, avatarData } = req.body || {};
  const fields = {};
  const nameIssue = validateText(displayName, 150, true);
  if (nameIssue) fields.displayName = nameIssue;
  const avatarIssue = validateAvatarData(avatarData);
  if (avatarIssue) fields.avatarData = avatarIssue;

  const shop = req.auth.role === "shop";
  if (shop) {
    for (const [key, value, max] of [["category", req.body?.category, 100], ["description", req.body?.description ?? "", 5000], ["contactInfo", req.body?.contactInfo ?? "", 255]]) {
      const issue = validateText(value, max, key === "category");
      if (issue) fields[key] = issue;
    }
  }
  if (Object.keys(fields).length) return sendError(res, 400, "VALIDATION_ERROR", "กรุณาตรวจสอบข้อมูลโปรไฟล์", fields);

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.query(
      "UPDATE users SET display_name = ?, avatar_data = ? WHERE id = ? AND is_active = 1",
      [displayName.trim(), avatarData || null, req.auth.userId]
    );
    let updatedShop = null;
    if (shop) {
      await connection.query(
        "UPDATE shops SET name = ?, category = ?, description = ?, contact_info = ? WHERE user_id = ?",
        [displayName.trim(), req.body.category.trim(), req.body.description.trim(), req.body.contactInfo.trim(), req.auth.userId]
      );
      const shops = await connection.query(
        "SELECT id, name, category, description, contact_info AS contactInfo FROM shops WHERE user_id = ?",
        [req.auth.userId]
      );
      updatedShop = shops.length ? { ...shops[0], id: String(shops[0].id) } : null;
      if (!updatedShop) throw new Error("Shop profile was not found for authenticated shop account");
    }
    await connection.commit();
    res.set("Cache-Control", "no-store");
    res.json({
      user: { displayName: displayName.trim(), avatarData: avatarData || null, role: req.auth.role },
      shop: updatedShop
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Profile update failed:", error.message);
    sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถบันทึกโปรไฟล์ได้");
  } finally {
    if (connection) connection.release();
  }
});

app.get("/api/markets/:marketId/reviews", async (req, res) => {
  const marketId = Number(req.params.marketId);
  if (!Number.isSafeInteger(marketId) || marketId < 1) return sendError(res, 400, "INVALID_MARKET", "ตลาดไม่ถูกต้อง");
  const session = getSession(req);
  let connection;
  try {
    connection = await pool.getConnection();
    const markets = await connection.query("SELECT id FROM markets WHERE id = ? AND is_active = 1", [marketId]);
    if (!markets.length) return sendError(res, 404, "NOT_FOUND", "ไม่พบตลาด");
    const summary = await connection.query(
      "SELECT COUNT(*) AS count, COALESCE(AVG(rating), 0) AS average FROM market_reviews WHERE market_id = ?",
      [marketId]
    );
    const reviews = await connection.query(
      `SELECT r.id, r.rating, r.comment, r.created_at AS createdAt,
        COALESCE(NULLIF(s.name, ''), NULLIF(u.display_name, ''), 'ผู้ใช้ตลาด') AS displayName
       FROM market_reviews r JOIN users u ON u.id = r.user_id
       LEFT JOIN shops s ON s.user_id = u.id
       WHERE r.market_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 50`,
      [marketId]
    );
    let myReview = null;
    if (session) {
      const mine = await connection.query(
        "SELECT id, rating, comment, created_at AS createdAt, updated_at AS updatedAt FROM market_reviews WHERE market_id = ? AND user_id = ?",
        [marketId, session.userId]
      );
      myReview = mine.length ? { ...mine[0], id: String(mine[0].id) } : null;
    }
    res.set("Cache-Control", "no-store");
    res.json({
      average: Number(summary[0].average),
      count: Number(summary[0].count),
      myReview,
      items: reviews.map((review) => ({ ...review, id: String(review.id) }))
    });
  } catch (error) {
    console.error("Market reviews read failed:", error.message);
    sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถโหลดรีวิวตลาดได้");
  } finally {
    if (connection) connection.release();
  }
});

app.put("/api/markets/:marketId/reviews", requireAuth, async (req, res) => {
  const marketId = Number(req.params.marketId);
  const rating = Number(req.body?.rating);
  const comment = req.body?.comment ?? "";
  if (!Number.isSafeInteger(marketId) || marketId < 1) return sendError(res, 400, "INVALID_MARKET", "ตลาดไม่ถูกต้อง");
  const fields = {};
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) fields.rating = "กรุณาให้คะแนน 1 ถึง 5 ดาว";
  const commentIssue = typeof comment !== "string" ? "กรุณากรอกรีวิวเป็นข้อความ" : validateText(comment, 1000, false);
  if (commentIssue) fields.comment = commentIssue;
  if (Object.keys(fields).length) return sendError(res, 400, "VALIDATION_ERROR", "กรุณาตรวจสอบรีวิว", fields);

  let connection;
  try {
    connection = await pool.getConnection();
    const markets = await connection.query("SELECT id FROM markets WHERE id = ? AND is_active = 1", [marketId]);
    if (!markets.length) return sendError(res, 404, "NOT_FOUND", "ไม่พบตลาด");
    await connection.query(
      `INSERT INTO market_reviews (market_id, user_id, rating, comment)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating), comment = VALUES(comment), updated_at = UTC_TIMESTAMP()`,
      [marketId, req.auth.userId, rating, comment.trim()]
    );
    res.set("Cache-Control", "no-store");
    res.json({ message: "บันทึกรีวิวเรียบร้อยแล้ว" });
  } catch (error) {
    console.error("Market review save failed:", error.message);
    sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถบันทึกรีวิวได้");
  } finally {
    if (connection) connection.release();
  }
});

app.get("/api/markets/:marketId/conversations", requireAuth, async (req, res) => {
  const marketId = Number(req.params.marketId);
  if (!Number.isSafeInteger(marketId) || marketId < 1) return sendError(res, 400, "INVALID_MARKET", "ตลาดไม่ถูกต้อง");
  let connection;
  try {
    connection = await pool.getConnection();
    const markets = await connection.query("SELECT id FROM markets WHERE id = ? AND is_active = 1", [marketId]);
    if (!markets.length) return sendError(res, 404, "NOT_FOUND", "ไม่พบตลาด");
    const where = req.auth.role === "admin" ? "c.market_id = ?" : "c.market_id = ? AND c.shop_user_id = ?";
    const params = req.auth.role === "admin" ? [marketId] : [marketId, req.auth.userId];
    const conversations = await connection.query(
      `SELECT c.id, c.shop_user_id AS shopUserId, c.updated_at AS updatedAt,
        COALESCE(NULLIF(s.name, ''), NULLIF(u.display_name, ''), 'ร้านค้า') AS shopName,
        (SELECT message FROM market_messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS lastMessage
       FROM market_conversations c JOIN users u ON u.id = c.shop_user_id
       LEFT JOIN shops s ON s.user_id = u.id
       WHERE ${where} ORDER BY c.updated_at DESC LIMIT 100`,
      params
    );
    res.set("Cache-Control", "no-store");
    res.json({
      items: conversations.map((conversation) => ({
        ...conversation,
        id: String(conversation.id),
        shopUserId: String(conversation.shopUserId)
      }))
    });
  } catch (error) {
    console.error("Market conversations read failed:", error.message);
    sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถโหลดข้อความตลาดได้");
  } finally {
    if (connection) connection.release();
  }
});

app.get("/api/conversations/:conversationId/messages", requireAuth, async (req, res) => {
  const conversationId = Number(req.params.conversationId);
  if (!Number.isSafeInteger(conversationId) || conversationId < 1) return sendError(res, 400, "INVALID_CONVERSATION", "ห้องสนทนาไม่ถูกต้อง");
  let connection;
  try {
    connection = await pool.getConnection();
    const where = req.auth.role === "admin" ? "id = ?" : "id = ? AND shop_user_id = ?";
    const params = req.auth.role === "admin" ? [conversationId] : [conversationId, req.auth.userId];
    const conversations = await connection.query(`SELECT id FROM market_conversations WHERE ${where}`, params);
    if (!conversations.length) return sendError(res, 404, "NOT_FOUND", "ไม่พบห้องสนทนา");
    const messages = await connection.query(
      `SELECT m.id, m.message, m.sender_role AS senderRole, m.created_at AS createdAt,
        COALESCE(NULLIF(s.name, ''), NULLIF(u.display_name, ''), IF(m.sender_role = 'admin', 'เจ้าของตลาด', 'ร้านค้า')) AS senderName
       FROM market_messages m JOIN users u ON u.id = m.sender_user_id
       LEFT JOIN shops s ON s.user_id = u.id
       WHERE m.conversation_id = ? ORDER BY m.id LIMIT 200`,
      [conversationId]
    );
    res.set("Cache-Control", "no-store");
    res.json({ items: messages.map((message) => ({ ...message, id: String(message.id) })) });
  } catch (error) {
    console.error("Conversation messages read failed:", error.message);
    sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถโหลดข้อความสนทนาได้");
  } finally {
    if (connection) connection.release();
  }
});

app.post("/api/markets/:marketId/messages", requireAuth, requireRole("shop"), async (req, res) => {
  const marketId = Number(req.params.marketId);
  const message = req.body?.message;
  const issue = validateText(message, 2000, true);
  if (!Number.isSafeInteger(marketId) || marketId < 1) return sendError(res, 400, "INVALID_MARKET", "ตลาดไม่ถูกต้อง");
  if (issue) return sendError(res, 400, "VALIDATION_ERROR", "กรุณากรอกข้อความไม่เกิน 2,000 ตัวอักษร", { message: issue });
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const markets = await connection.query("SELECT id FROM markets WHERE id = ? AND is_active = 1 FOR UPDATE", [marketId]);
    if (!markets.length) {
      await connection.rollback();
      return sendError(res, 404, "NOT_FOUND", "ไม่พบตลาด");
    }
    const conversation = await connection.query(
      "INSERT INTO market_conversations (market_id, shop_user_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)",
      [marketId, req.auth.userId]
    );
    await connection.query(
      "INSERT INTO market_messages (conversation_id, sender_user_id, sender_role, message) VALUES (?, ?, 'shop', ?)",
      [conversation.insertId, req.auth.userId, message.trim()]
    );
    await connection.query("UPDATE market_conversations SET updated_at = UTC_TIMESTAMP() WHERE id = ?", [conversation.insertId]);
    await connection.commit();
    res.status(201).json({ conversationId: String(conversation.insertId), message: "ส่งข้อความถึงเจ้าของตลาดแล้ว" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Market message send failed:", error.message);
    sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถส่งข้อความได้");
  } finally {
    if (connection) connection.release();
  }
});

app.post("/api/conversations/:conversationId/messages", requireAuth, async (req, res) => {
  const conversationId = Number(req.params.conversationId);
  const message = req.body?.message;
  const issue = validateText(message, 2000, true);
  if (!Number.isSafeInteger(conversationId) || conversationId < 1) return sendError(res, 400, "INVALID_CONVERSATION", "ห้องสนทนาไม่ถูกต้อง");
  if (issue) return sendError(res, 400, "VALIDATION_ERROR", "กรุณากรอกข้อความไม่เกิน 2,000 ตัวอักษร", { message: issue });
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const where = req.auth.role === "admin" ? "id = ?" : "id = ? AND shop_user_id = ?";
    const params = req.auth.role === "admin" ? [conversationId] : [conversationId, req.auth.userId];
    const conversations = await connection.query(`SELECT id FROM market_conversations WHERE ${where} FOR UPDATE`, params);
    if (!conversations.length) {
      await connection.rollback();
      return sendError(res, 404, "NOT_FOUND", "ไม่พบห้องสนทนา");
    }
    await connection.query(
      "INSERT INTO market_messages (conversation_id, sender_user_id, sender_role, message) VALUES (?, ?, ?, ?)",
      [conversationId, req.auth.userId, req.auth.role, message.trim()]
    );
    await connection.query("UPDATE market_conversations SET updated_at = UTC_TIMESTAMP() WHERE id = ?", [conversationId]);
    await connection.commit();
    res.status(201).json({ message: "ส่งข้อความเรียบร้อยแล้ว" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Conversation reply send failed:", error.message);
    sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถส่งข้อความได้");
  } finally {
    if (connection) connection.release();
  }
});

app.get("/api/markets", async (req, res) => {
  const pagination = parsePagination(req.query);
  if (!pagination) return sendError(res, 400, "INVALID_PAGINATION", "ค่าหน้าหรือจำนวนรายการไม่ถูกต้อง");
  const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const search = `%${query}%`;
  let connection;
  try {
    connection = await pool.getConnection();
    const markets = await connection.query(
      `SELECT id, name, description, location FROM markets
       WHERE is_active = 1 AND (? = '' OR name LIKE ? OR location LIKE ?)
       ORDER BY name LIMIT ? OFFSET ?`, [query, search, search, pagination.limit, pagination.offset]
    );
    const items = markets.map((market) => ({ ...market, id: String(market.id) }));
    const countRows = await connection.query(
      `SELECT COUNT(*) AS total FROM markets
       WHERE is_active = 1 AND (? = '' OR name LIKE ? OR location LIKE ?)`, [query, search, search]
    );
    res.set("Cache-Control", "no-store");
    res.json({ items, page: pagination.page, limit: pagination.limit, total: Number(countRows[0].total) });
  } catch (error) {
    console.error("Market listing failed:", error.message);
    sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถโหลดรายการตลาดได้");
  } finally {
    if (connection) connection.release();
  }
});

app.get("/api/markets/:marketId/qr", async (req, res) => {
  const marketId = Number(req.params.marketId);
  if (!Number.isSafeInteger(marketId) || marketId < 1) return sendError(res, 400, "INVALID_MARKET", "ตลาดไม่ถูกต้อง");
  let connection;
  try {
    connection = await pool.getConnection();
    const markets = await connection.query("SELECT id FROM markets WHERE id = ? AND is_active = 1", [marketId]);
    if (!markets.length) return sendError(res, 404, "NOT_FOUND", "ไม่พบตลาด");
    const target = new URL("/", `${req.protocol}://${req.get("host")}`);
    target.searchParams.set("market", String(marketId));
    const svg = await QRCode.toString(target.toString(), {
      type: "svg",
      errorCorrectionLevel: "Q",
      margin: 2,
      width: 240,
      color: { dark: "#203b38", light: "#ffffff" }
    });
    res.set({
      "Cache-Control": "no-store",
      "Content-Type": "image/svg+xml; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    });
    res.send(svg);
  } catch (error) {
    console.error("Market QR generation failed:", error.message);
    sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถสร้าง QR Code ของตลาดได้");
  } finally {
    if (connection) connection.release();
  }
});

app.get("/api/markets/:marketId/sessions", async (req, res) => {
  const marketId = Number(req.params.marketId);
  if (!Number.isSafeInteger(marketId) || marketId < 1) return sendError(res, 400, "INVALID_MARKET", "ตลาดไม่ถูกต้อง");
  const date = typeof req.query.date === "string" ? req.query.date : "";
  if (date) {
    const parsedDate = new Date(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
      return sendError(res, 400, "INVALID_DATE", "วันที่ไม่ถูกต้อง");
    }
  }
  const now = getBangkokDateTime();
  const conditions = ["market_id = ?", "is_published = 1", "starts_at > ?"];
  const params = [marketId, now];
  if (date) {
    conditions.push("DATE(starts_at) = ?");
    params.push(date);
  }
  if (req.query.bookingOpen === "true") {
    conditions.push("booking_open = 1", "starts_at >= DATE_ADD(?, INTERVAL 1 DAY)");
    params.push(now);
  }
  let connection;
  try {
    connection = await pool.getConnection();
    const sessions = await connection.query(
      `SELECT id, name, DATE_FORMAT(starts_at, '%Y-%m-%d %H:%i:%s') AS startsAt,
        DATE_FORMAT(ends_at, '%Y-%m-%d %H:%i:%s') AS endsAt,
        DATE_FORMAT(DATE_SUB(starts_at, INTERVAL 1 DAY), '%Y-%m-%d %H:%i:%s') AS bookingDeadlineAt,
        booking_open AS bookingEnabled,
        (booking_open = 1 AND starts_at >= DATE_ADD(?, INTERVAL 1 DAY)) AS bookingEligible
       FROM market_sessions WHERE ${conditions.join(" AND ")}
       ORDER BY starts_at LIMIT 100`, [now, ...params]
    );
    res.set("Cache-Control", "no-store");
    res.json({
      items: sessions.map((session) => ({
        ...session,
        id: String(session.id),
        bookingOpen: Boolean(session.bookingEligible)
      }))
    });
  } catch (error) {
    console.error("Market sessions listing failed:", error.message);
    sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถโหลดปฏิทินตลาดได้");
  } finally {
    if (connection) connection.release();
  }
});

app.get("/api/sessions/:sessionId/booths", async (req, res) => {
  const sessionId = Number(req.params.sessionId);
  if (!Number.isSafeInteger(sessionId) || sessionId < 1) return sendError(res, 400, "INVALID_SESSION", "รอบตลาดไม่ถูกต้อง");
  let connection;
  try {
    connection = await pool.getConnection();
    const rounds = await connection.query("SELECT id, market_id AS marketId, name, starts_at AS startsAt, ends_at AS endsAt FROM market_sessions WHERE id = ? AND is_published = 1", [sessionId]);
    if (!rounds.length) return sendError(res, 404, "NOT_FOUND", "ไม่พบรอบตลาดที่เผยแพร่");
    const booths = await connection.query(
      `SELECT b.id, b.booth_code AS code, b.map_x AS x, b.map_y AS y,
        CASE WHEN bk.id IS NULL THEN 'available' ELSE 'occupied' END AS status,
        s.name AS shopName, s.category, s.description, s.contact_info AS contactInfo
       FROM booths b
       LEFT JOIN bookings bk ON bk.session_id = ? AND bk.booth_id = b.id AND bk.status = 'confirmed'
       LEFT JOIN shops s ON s.id = bk.shop_id
       WHERE b.market_id = ? AND b.is_active = 1 ORDER BY b.booth_code`, [sessionId, rounds[0].marketId]
    );
    res.set("Cache-Control", "no-store");
    res.json({
      session: { ...rounds[0], id: String(rounds[0].id), marketId: String(rounds[0].marketId) },
      booths: booths.map((booth) => ({ ...booth, id: String(booth.id) }))
    });
  } catch (error) {
    console.error("Public booth map failed:", error.message);
    sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถโหลดแผนผังได้");
  } finally { if (connection) connection.release(); }
});

app.get("/api/shop/bookings", requireAuth, requireRole("shop"), async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const rows = await connection.query(
      `SELECT bk.id, bk.status, bk.booked_at AS bookedAt, bk.cancelled_at AS cancelledAt,
        b.booth_code AS boothCode, ms.id AS sessionId, ms.name AS sessionName,
        ms.starts_at AS startsAt, ms.ends_at AS endsAt, m.id AS marketId, m.name AS marketName, m.location
       FROM bookings bk JOIN booths b ON b.id = bk.booth_id
       JOIN market_sessions ms ON ms.id = bk.session_id JOIN markets m ON m.id = ms.market_id
       WHERE bk.shop_id = ? ORDER BY bk.booked_at DESC LIMIT 100`, [req.auth.shopId]
    );
    res.set("Cache-Control", "no-store"); res.json({ items: rows });
  } catch (error) {
    console.error("Shop bookings read failed:", error.message);
    sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถโหลดรายการจองได้");
  } finally { if (connection) connection.release(); }
});

app.post("/api/sessions/:sessionId/bookings", requireAuth, requireRole("shop"), async (req, res) => {
  const sessionId = Number(req.params.sessionId), boothId = Number(req.body?.boothId);
  if (!Number.isSafeInteger(sessionId) || sessionId < 1 || !Number.isSafeInteger(boothId) || boothId < 1) return sendError(res, 400, "INVALID_BOOKING", "รอบตลาดหรือแผงไม่ถูกต้อง");
  const now = getBangkokDateTime();
  let connection;
  try {
    connection = await pool.getConnection(); await connection.beginTransaction();
    const rounds = await connection.query(
      "SELECT id, market_id FROM market_sessions WHERE id = ? AND booking_open = 1 AND is_published = 1 AND starts_at >= DATE_ADD(?, INTERVAL 1 DAY) FOR UPDATE",
      [sessionId, now]
    );
    if (!rounds.length) { await connection.rollback(); return sendError(res, 409, "BOOKING_CLOSED", "รอบตลาดนี้ยังไม่เปิดหรือปิดรับจองแล้ว"); }
    const booths = await connection.query("SELECT id FROM booths WHERE id = ? AND market_id = ? AND is_active = 1 FOR UPDATE", [boothId, rounds[0].market_id]);
    if (!booths.length) { await connection.rollback(); return sendError(res, 404, "BOOTH_NOT_FOUND", "ไม่พบแผงที่เลือก"); }
    const result = await connection.query("INSERT INTO bookings (session_id, booth_id, shop_id, status, booked_at) VALUES (?, ?, ?, 'confirmed', UTC_TIMESTAMP())", [sessionId, boothId, req.auth.shopId]);
    await connection.commit(); res.status(201).json({ id: Number(result.insertId), sessionId, boothId, status: "confirmed" });
  } catch (error) {
    if (connection) await connection.rollback();
    if (error.code === "ER_DUP_ENTRY") return sendError(res, 409, "BOOKING_CONFLICT", "แผงถูกจองแล้ว หรือร้านของคุณมีการจองในรอบนี้แล้ว");
    console.error("Booking create failed:", error.message); sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถจองแผงได้");
  } finally { if (connection) connection.release(); }
});

app.delete("/api/bookings/:bookingId", requireAuth, requireRole("shop"), async (req, res) => {
  const bookingId = Number(req.params.bookingId);
  if (!Number.isSafeInteger(bookingId) || bookingId < 1) return sendError(res, 400, "INVALID_BOOKING", "รายการจองไม่ถูกต้อง");
  let connection;
  try {
    connection = await pool.getConnection();
    const result = await connection.query("UPDATE bookings SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP() WHERE id = ? AND shop_id = ? AND status = 'confirmed'", [bookingId, req.auth.shopId]);
    if (!result.affectedRows) return sendError(res, 404, "BOOKING_NOT_FOUND", "ไม่พบรายการจองที่ยังใช้งานได้");
    res.json({ id: bookingId, status: "cancelled" });
  } catch (error) {
    console.error("Booking cancellation failed:", error.message); sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถยกเลิกการจองได้");
  } finally { if (connection) connection.release(); }
});

app.get("/api/shop/profile", requireAuth, requireRole("shop"), async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const rows = await connection.query("SELECT id, name, category, description, contact_info AS contactInfo FROM shops WHERE id = ? AND user_id = ?", [req.auth.shopId, req.auth.userId]);
    if (!rows.length) return sendError(res, 404, "NOT_FOUND", "ไม่พบข้อมูลร้านค้า");
    res.set("Cache-Control", "no-store");
    res.json(rows[0]);
  } catch (error) {
    console.error("Shop profile read failed:", error.message);
    sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถโหลดข้อมูลร้านค้าได้");
  } finally {
    if (connection) connection.release();
  }
});

app.patch("/api/shop/profile", requireAuth, requireRole("shop"), async (req, res) => {
  const allowed = { name: ["name", 150, true], category: ["category", 100, true], description: ["description", 5000, false], contactInfo: ["contact_info", 255, false] };
  const updates = [];
  const values = [];
  const fields = {};
  for (const [key, value] of Object.entries(req.body || {})) {
    if (!allowed[key]) { fields[key] = "ฟิลด์นี้ไม่อนุญาต"; continue; }
    const [column, max, required] = allowed[key];
    const issue = validateText(value, max, required);
    if (issue) fields[key] = issue;
    else { updates.push(`${column} = ?`); values.push(value.trim()); }
  }
  if (!updates.length && !Object.keys(fields).length) return sendError(res, 400, "VALIDATION_ERROR", "ไม่มีข้อมูลสำหรับบันทึก");
  if (Object.keys(fields).length) return sendError(res, 400, "VALIDATION_ERROR", "กรุณาตรวจสอบข้อมูลที่กรอก", fields);
  updates.push("updated_at = UTC_TIMESTAMP()");
  values.push(req.auth.shopId, req.auth.userId);
  let connection;
  try {
    connection = await pool.getConnection();
    const result = await connection.query(`UPDATE shops SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`, values);
    if (!result.affectedRows) return sendError(res, 404, "NOT_FOUND", "ไม่พบข้อมูลร้านค้า");
    const rows = await connection.query("SELECT id, name, category, description, contact_info AS contactInfo FROM shops WHERE id = ?", [req.auth.shopId]);
    res.set("Cache-Control", "no-store");
    res.json(rows[0]);
  } catch (error) {
    console.error("Shop profile update failed:", error.message);
    sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถบันทึกข้อมูลร้านค้าได้");
  } finally {
    if (connection) connection.release();
  }
});

app.use("/api", (req, res) => sendError(res, 404, "NOT_FOUND", "ไม่พบ API ที่ร้องขอ"));
app.use((error, req, res, next) => {
  if (error && error.type === "entity.too.large") return sendError(res, 413, "REQUEST_TOO_LARGE", "ข้อมูลที่ส่งมามีขนาดใหญ่เกินไป");
  if (error instanceof SyntaxError && "body" in error) return sendError(res, 400, "INVALID_JSON", "รูปแบบ JSON ไม่ถูกต้อง");
  console.error("Unhandled request error:", error.message);
  sendError(res, 500, "INTERNAL_ERROR", "เกิดข้อผิดพลาดภายในระบบ");
});

ensureSchema().then(() => {
  app.listen(3110, () => console.log(`Server running at http://localhost:${port}`));
}).catch((error) => {
  console.error("Database schema setup failed:", error.message);
  process.exitCode = 1;
});
