const express = require("express");
const mariadb = require("mariadb");
const crypto = require("crypto");
const scrypt = require("crypto").scrypt;
const { promisify } = require("util");
const scryptAsync = promisify(scrypt);

const app = express();
const port = 3110;
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

app.use(express.json({ limit: "32kb" }));
app.use(express.static("public"));

async function ensureSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, email VARCHAR(254) NOT NULL, password_hash VARCHAR(255) NOT NULL, role ENUM('shop','admin') NOT NULL DEFAULT 'shop', is_active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (id), UNIQUE KEY uq_users_email (email), KEY idx_users_role_active (role,is_active)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS shops (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, user_id BIGINT UNSIGNED NOT NULL, name VARCHAR(150) NOT NULL, category VARCHAR(100) NOT NULL, description TEXT NULL, contact_info VARCHAR(255) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (id), UNIQUE KEY uq_shops_user_id (user_id), KEY idx_shops_category (category), CONSTRAINT fk_shops_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS markets (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, name VARCHAR(150) NOT NULL, description TEXT NULL, location VARCHAR(255) NOT NULL, is_active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (id), KEY idx_markets_active_name (is_active,name)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS market_sessions (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, market_id BIGINT UNSIGNED NOT NULL, name VARCHAR(100) NOT NULL, starts_at DATETIME NOT NULL, ends_at DATETIME NOT NULL, booking_open TINYINT(1) NOT NULL DEFAULT 0, map_token CHAR(36) NOT NULL, is_published TINYINT(1) NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (id), UNIQUE KEY uq_market_sessions_map_token (map_token), KEY idx_sessions_market_start (market_id,starts_at), KEY idx_sessions_public (is_published,starts_at), CONSTRAINT fk_sessions_market FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE RESTRICT ON UPDATE RESTRICT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
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

function validateText(value, maxLength, required) {
  if (typeof value !== "string") return required ? "กรุณากรอกข้อมูล" : null;
  const text = value.trim();
  if (required && !text) return "กรุณากรอกข้อมูล";
  if (text.length > maxLength) return `ต้องมีความยาวไม่เกิน ${maxLength} ตัวอักษร`;
  return null;
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
  if (typeof email !== "string" || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) || email.length > 254) fields.email = "กรุณากรอกอีเมลที่ถูกต้อง";
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
    const users = await connection.query("SELECT id, email, role FROM users WHERE id = ? AND is_active = 1", [req.auth.userId]);
    if (!users.length) return sendError(res, 401, "UNAUTHENTICATED", "กรุณาเข้าสู่ระบบอีกครั้ง");
    let shop = null;
    if (users[0].role === "shop") {
      const shops = await connection.query("SELECT id, name, category, description, contact_info AS contactInfo FROM shops WHERE user_id = ?", [req.auth.userId]);
      shop = shops[0] || null;
    }
    res.set("Cache-Control", "no-store");
    res.json({ user: { id: Number(users[0].id), email: users[0].email, role: users[0].role }, shop });
  } catch (error) {
    console.error("Session check failed:", error.message);
    sendError(res, 500, "INTERNAL_ERROR", "ไม่สามารถตรวจสอบบัญชีได้");
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
    const items = await connection.query(
      `SELECT id, name, description, location FROM markets
       WHERE is_active = 1 AND (? = '' OR name LIKE ? OR location LIKE ?)
       ORDER BY name LIMIT ? OFFSET ?`, [query, search, search, pagination.limit, pagination.offset]
    );
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
    res.json({ session: rounds[0], booths });
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
  let connection;
  try {
    connection = await pool.getConnection(); await connection.beginTransaction();
    const rounds = await connection.query("SELECT id, market_id FROM market_sessions WHERE id = ? AND booking_open = 1 AND is_published = 1 FOR UPDATE", [sessionId]);
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
  app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
}).catch((error) => {
  console.error("Database schema setup failed:", error.message);
  process.exitCode = 1;
});
