const statusElement = document.querySelector("#status");
const resultsElement = document.querySelector("#market-results");
const searchInput = document.querySelector("#market-search");
const searchButton = document.querySelector("#search-markets");
const authDialog = document.querySelector("#auth-dialog");
const authForm = document.querySelector("#auth-form");
const authMessage = document.querySelector("#auth-message");
const registerFields = document.querySelector("#register-fields");
const authTitle = document.querySelector("#auth-title");
const authSubmit = document.querySelector("#auth-submit");
const loginTab = document.querySelector("#login-tab");
const registerTab = document.querySelector("#register-tab");
const accountPanel = document.querySelector("#account-panel");
const profileForm = document.querySelector("#profile-form");
const profileMessage = document.querySelector("#profile-message");
const marketDetail = document.querySelector("#market-detail");
const detailTitle = document.querySelector("#detail-title");
const detailLocation = document.querySelector("#detail-location");
const sessionDate = document.querySelector("#session-date");
const sessionSelect = document.querySelector("#session-select");
const calendarMessage = document.querySelector("#calendar-message");
const sessionSummary = document.querySelector("#session-summary");
const boothGrid = document.querySelector("#booth-grid");
const bookingNote = document.querySelector("#booking-note");
const avatarFile = document.querySelector("#avatar-file");
const avatarImage = document.querySelector("#avatar-image");
const avatarInitial = document.querySelector("#avatar-initial");
const profileRole = document.querySelector("#profile-role");
const shopProfileFields = document.querySelector("#shop-profile-fields");
const chatAuthPrompt = document.querySelector("#chat-auth-prompt");
const chatContent = document.querySelector("#chat-content");
const chatStatus = document.querySelector("#chat-status");
const chatThread = document.querySelector("#chat-thread");
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const conversationPickerWrap = document.querySelector("#conversation-picker-wrap");
const conversationPicker = document.querySelector("#conversation-picker");
const reviewAuthPrompt = document.querySelector("#review-auth-prompt");
const reviewForm = document.querySelector("#review-form");
const reviewStatus = document.querySelector("#review-status");
const reviewLoadStatus = document.querySelector("#review-load-status");
const reviewList = document.querySelector("#review-list");
let authMode = "login";
let activeMarket = null;
let activeSessions = [];
let activeConversationId = null;
let selectedBooth = null;
let currentAvatarData = null;
let currentProfileRole = null;
let returnToProfile = false;

function setStatus(message) { statusElement.textContent = message; }

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || "เกิดข้อผิดพลาด กรุณาลองใหม่");
  return data;
}

function showMessage(title, message) {
  resultsElement.replaceChildren();
  const card = document.createElement("div"); card.className = "empty-card";
  const icon = document.createElement("span"); icon.className = "empty-icon"; icon.setAttribute("aria-hidden", "true"); icon.textContent = "⌖";
  const content = document.createElement("div"); const heading = document.createElement("strong"); heading.textContent = title;
  const detail = document.createElement("p"); detail.textContent = message; content.append(heading, detail); card.append(icon, content); resultsElement.append(card);
}

function renderMarkets(markets) {
  resultsElement.replaceChildren();
  if (!markets.length) return showMessage("ยังไม่พบตลาดที่เปิดให้เข้าชม", "ลองค้นหาด้วยชื่ออื่น หรือสแกน QR Code ของตลาดเพื่อดูแผนผัง");
  markets.forEach((market) => {
    const card = document.createElement("article"); card.className = "market-card";
    const details = document.createElement("div"); const title = document.createElement("h3"); title.textContent = market.name;
    const location = document.createElement("p"); location.textContent = market.location || "สถานที่จะแจ้งให้ทราบ"; details.append(title, location);
    const button = document.createElement("button"); button.className = "button"; button.type = "button"; button.textContent = "ดูตลาดและจองพื้นที่"; button.addEventListener("click", () => openMarket(market));
    const qr = document.createElement("a"); qr.className = "market-qr"; qr.href = `/api/markets/${encodeURIComponent(market.id)}/qr`; qr.download = `market-${market.id}-qr.svg`; qr.setAttribute("aria-label", `ดาวน์โหลด QR Code สำหรับ${market.name}`);
    const qrImage = document.createElement("img"); qrImage.src = qr.href; qrImage.alt = `QR Code สำหรับเปิด${market.name}และจองพื้นที่`; qrImage.width = 120; qrImage.height = 120; qrImage.loading = "lazy";
    const qrCaption = document.createElement("span"); qrCaption.textContent = "ดาวน์โหลด QR";
    qr.append(qrImage, qrCaption);
    card.append(details, button, qr); resultsElement.append(card);
  });
}

function formatSessionDate(value) {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat("th-TH", { dateStyle: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}

function bangkokToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function renderSessionOptions(sessions, preferredId = "") {
  activeSessions = sessions;
  sessionSelect.replaceChildren();
  const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = sessions.length ? "เลือกรอบตลาด" : "ไม่มีรอบในวันที่เลือก";
  sessionSelect.append(placeholder);
  sessions.forEach((session) => {
    const option = document.createElement("option");
    option.value = session.id;
    option.textContent = `${session.startsAt.slice(11, 16)}–${session.endsAt.slice(11, 16)}${session.bookingOpen ? " · จองได้" : ""}`;
    sessionSelect.append(option);
  });
  sessionSelect.disabled = !sessions.length;
  const chosen = sessions.find((session) => session.id === preferredId) || sessions.find((session) => session.bookingOpen) || sessions[0];
  if (chosen) {
    sessionSelect.value = chosen.id;
    loadBooths(chosen);
  } else {
    boothGrid.replaceChildren();
    sessionSummary.textContent = "ไม่มีรอบตลาดในวันที่เลือก";
    bookingNote.textContent = "";
  }
}

async function loadMarketSessions(date = "") {
  if (!activeMarket) return;
  calendarMessage.textContent = "กำลังโหลดรอบตลาด...";
  sessionSelect.disabled = true;
  try {
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    const data = await request(`/api/markets/${encodeURIComponent(activeMarket.id)}/sessions?${params}`);
    calendarMessage.textContent = "";
    const sessions = data.items || [];
    if (!date && sessions.length) {
      const firstBookable = sessions.find((session) => session.bookingOpen) || sessions[0];
      sessionDate.value = firstBookable.startsAt.slice(0, 10);
      await loadMarketSessions(sessionDate.value);
      return;
    }
    renderSessionOptions(sessions);
  } catch (error) {
    calendarMessage.textContent = error.message;
    sessionSelect.replaceChildren(new Option("โหลดรอบตลาดไม่สำเร็จ", ""));
    boothGrid.replaceChildren();
  }
}

async function openMarket(market) {
  activeMarket = market;
  selectedBooth = null;
  detailTitle.textContent = market.name;
  detailLocation.textContent = market.location || "จังหวัดตาก";
  sessionDate.min = bangkokToday();
  sessionDate.value = "";
  document.querySelector("#home > .hero").hidden = true;
  document.querySelector("#home > .market-section").hidden = true;
  document.querySelector("#home > .shop-banner").hidden = true;
  marketDetail.hidden = false;
  marketDetail.scrollIntoView({ behavior: "smooth", block: "start" });
  await Promise.all([loadMarketSessions(), loadMarketCommunity()]);
}

document.querySelector("#back-to-markets").addEventListener("click", () => {
  marketDetail.hidden = true;
  document.querySelector("#home > .hero").hidden = false;
  document.querySelector("#home > .market-section").hidden = false;
  document.querySelector("#home > .shop-banner").hidden = false;
  document.querySelector("#markets").scrollIntoView({ behavior: "smooth" });
});

sessionDate.addEventListener("change", () => loadMarketSessions(sessionDate.value));
sessionSelect.addEventListener("change", () => {
  const selected = activeSessions.find((session) => session.id === sessionSelect.value);
  if (selected) loadBooths(selected);
});

function formatReviewDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeZone: "Asia/Bangkok" }).format(date);
}

function renderReviews(data) {
  document.querySelector("#review-average").textContent = data.count ? Number(data.average).toFixed(1) : "—";
  const rounded = Math.round(Number(data.average) || 0);
  const averageStars = document.querySelector("#review-average-stars");
  averageStars.textContent = `${"★".repeat(rounded)}${"☆".repeat(5 - rounded)}`;
  averageStars.setAttribute("aria-label", data.count ? `เฉลี่ย ${Number(data.average).toFixed(1)} จาก 5 ดาว` : "ยังไม่มีคะแนน");
  document.querySelector("#review-count").textContent = `${data.count} รีวิว`;
  reviewList.replaceChildren();
  if (!data.items?.length) {
    const empty = document.createElement("p"); empty.className = "community-empty"; empty.textContent = "ยังไม่มีรีวิว เป็นคนแรกที่แบ่งปันประสบการณ์ได้เลย";
    reviewList.append(empty);
  } else {
    data.items.forEach((review) => {
      const article = document.createElement("article"); article.className = "review-item";
      const heading = document.createElement("div"); heading.className = "review-item-heading";
      const name = document.createElement("strong"); name.textContent = review.displayName;
      const stars = document.createElement("span"); stars.className = "review-stars"; stars.textContent = `${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)}`; stars.setAttribute("aria-label", `${review.rating} จาก 5 ดาว`);
      const date = document.createElement("time"); date.textContent = formatReviewDate(review.createdAt);
      heading.append(name, stars, date);
      const comment = document.createElement("p"); comment.textContent = review.comment || "ให้คะแนนตลาด";
      article.append(heading, comment); reviewList.append(article);
    });
  }
  if (data.myReview) {
    reviewForm.elements.rating.value = String(data.myReview.rating);
    reviewForm.elements.comment.value = data.myReview.comment || "";
    reviewForm.querySelector("button[type=submit]").textContent = "อัปเดตรีวิว";
  } else {
    reviewForm.reset();
    reviewForm.querySelector("button[type=submit]").textContent = "บันทึกรีวิว";
  }
}

async function loadMarketReviews() {
  reviewLoadStatus.textContent = "กำลังโหลดรีวิว...";
  try {
    const data = await request(`/api/markets/${encodeURIComponent(activeMarket.id)}/reviews`);
    renderReviews(data);
    reviewLoadStatus.textContent = "";
  } catch (error) {
    reviewLoadStatus.textContent = error.message;
  }
}

function renderChatMessages(messages) {
  chatThread.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement("p"); empty.className = "community-empty"; empty.textContent = "เริ่มต้นพูดคุยได้ด้วยการส่งข้อความด้านล่าง";
    chatThread.append(empty);
    return;
  }
  messages.forEach((message) => {
    const item = document.createElement("article");
    item.className = `chat-message ${message.senderRole === currentProfileRole ? "mine" : "theirs"}`;
    const meta = document.createElement("div"); meta.className = "chat-message-meta";
    const sender = document.createElement("strong"); sender.textContent = message.senderName;
    const date = document.createElement("time"); date.textContent = formatReviewDate(message.createdAt);
    meta.append(sender, date);
    const body = document.createElement("p"); body.textContent = message.message;
    item.append(meta, body); chatThread.append(item);
  });
  chatThread.scrollTop = chatThread.scrollHeight;
}

async function loadConversationMessages() {
  if (!activeConversationId) {
    chatThread.replaceChildren();
    chatForm.hidden = currentProfileRole !== "shop";
    return;
  }
  chatStatus.textContent = "กำลังโหลดข้อความ...";
  try {
    const data = await request(`/api/conversations/${encodeURIComponent(activeConversationId)}/messages`);
    renderChatMessages(data.items || []);
    chatStatus.textContent = "";
    chatForm.hidden = false;
  } catch (error) {
    chatStatus.textContent = error.message;
  }
}

async function loadMarketConversations() {
  if (!activeMarket || !currentProfileRole) return;
  chatStatus.textContent = "กำลังโหลดกล่องข้อความ...";
  try {
    const data = await request(`/api/markets/${encodeURIComponent(activeMarket.id)}/conversations`);
    const conversations = data.items || [];
    conversationPickerWrap.hidden = currentProfileRole !== "admin";
    if (currentProfileRole === "admin") {
      conversationPicker.replaceChildren();
      const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = conversations.length ? "เลือกบทสนทนา" : "ยังไม่มีข้อความ";
      conversationPicker.append(placeholder);
      conversations.forEach((conversation) => {
        const option = document.createElement("option"); option.value = conversation.id;
        option.textContent = `${conversation.shopName} · ${conversation.lastMessage || "ไม่มีข้อความ"}`;
        conversationPicker.append(option);
      });
      activeConversationId = conversations.some((item) => item.id === activeConversationId) ? activeConversationId : (conversations[0]?.id || null);
      conversationPicker.value = activeConversationId || "";
      chatForm.hidden = !activeConversationId;
    } else {
      activeConversationId = conversations[0]?.id || null;
      chatForm.hidden = false;
    }
    chatStatus.textContent = conversations.length || currentProfileRole === "shop" ? "" : "ยังไม่มีข้อความจากร้านค้า";
    await loadConversationMessages();
  } catch (error) {
    chatStatus.textContent = error.message;
    chatForm.hidden = true;
  }
}

async function loadMarketCommunity() {
  activeConversationId = null;
  chatThread.replaceChildren();
  chatStatus.textContent = "";
  reviewStatus.textContent = "";
  await loadMarketReviews();
  const isLoggedIn = Boolean(currentProfileRole);
  chatAuthPrompt.hidden = isLoggedIn;
  reviewAuthPrompt.hidden = isLoggedIn;
  chatContent.hidden = !isLoggedIn;
  document.querySelector("#refresh-conversations").hidden = !isLoggedIn;
  reviewForm.hidden = !isLoggedIn;
  if (isLoggedIn) await loadMarketConversations();
}

document.querySelector("#chat-login").addEventListener("click", () => openAuth());
document.querySelector("#review-login").addEventListener("click", () => openAuth());
document.querySelector("#refresh-conversations").addEventListener("click", () => loadMarketConversations());
conversationPicker.addEventListener("change", async () => {
  activeConversationId = conversationPicker.value || null;
  chatForm.hidden = !activeConversationId;
  await loadConversationMessages();
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeMarket) return;
  const message = chatInput.value.trim();
  if (!message) return;
  chatStatus.textContent = "กำลังส่งข้อความ...";
  const submit = chatForm.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const path = activeConversationId
      ? `/api/conversations/${encodeURIComponent(activeConversationId)}/messages`
      : `/api/markets/${encodeURIComponent(activeMarket.id)}/messages`;
    const data = await request(path, { method: "POST", body: JSON.stringify({ message }) });
    if (data.conversationId) activeConversationId = data.conversationId;
    chatInput.value = "";
    await loadMarketConversations();
    chatStatus.textContent = data.message;
  } catch (error) {
    chatStatus.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

reviewForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeMarket) return;
  const rating = Number(reviewForm.elements.rating.value);
  reviewStatus.textContent = "กำลังบันทึกรีวิว...";
  const submit = reviewForm.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    await request(`/api/markets/${encodeURIComponent(activeMarket.id)}/reviews`, {
      method: "PUT",
      body: JSON.stringify({ rating, comment: reviewForm.elements.comment.value })
    });
    reviewStatus.textContent = "บันทึกรีวิวเรียบร้อยแล้ว";
    await loadMarketReviews();
  } catch (error) {
    reviewStatus.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

async function loadBooths(session) {
  sessionSummary.textContent = `${formatSessionDate(session.startsAt)} · ${session.startsAt.slice(11, 16)}–${session.endsAt.slice(11, 16)}`;
  bookingNote.textContent = session.bookingOpen
    ? `เปิดจองแล้ว · กรุณาจองก่อน ${session.bookingDeadlineAt.slice(0, 16)} (เวลาไทย)`
    : "ปิดรับจองแล้ว · ต้องจองก่อนเวลาเริ่มตลาดอย่างน้อย 24 ชั่วโมง";
  boothGrid.replaceChildren();
  try {
    const data = await request(`/api/sessions/${encodeURIComponent(session.id)}/booths`);
    const boothMap = new Map((data.booths || []).map((booth) => [booth.code, booth]));
    ["A", "B", "C", "D", "E"].forEach((row) => {
      for (let number = 1; number <= 12; number += 1) {
        const code = `${row}${number}`;
        const booth = boothMap.get(code);
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = `booth-cell ${booth?.status === "occupied" ? "occupied" : "available"}`;
        cell.textContent = code;
        cell.setAttribute("aria-label", `${code} ${booth?.status === "occupied" ? "ถูกจองแล้ว" : session.bookingOpen ? "ว่าง พร้อมจอง" : "ว่าง ยังไม่เปิดจอง"}`);
        cell.disabled = !booth || booth.status === "occupied" || !session.bookingOpen;
        if (booth?.status === "occupied" && booth.shopName) cell.title = `ร้าน ${booth.shopName}`;
        if (!booth) cell.title = "พื้นที่นี้ยังไม่ถูกตั้งค่า";
        if (booth && booth.status !== "occupied") cell.addEventListener("click", () => reserveBooth(session, booth));
        boothGrid.append(cell);
      }
    });
  } catch (error) {
    const message = document.createElement("p"); message.className = "map-error"; message.textContent = error.message;
    boothGrid.append(message);
  }
}

async function reserveBooth(session, booth) {
  selectedBooth = { session, booth };
  try {
    const account = await request("/api/auth/me");
    if (account.user.role !== "shop") throw new Error("เข้าสู่ระบบด้วยบัญชีร้านค้าเพื่อจองพื้นที่");
    const confirmed = window.confirm(`ยืนยันจองพื้นที่ ${booth.code} ใน${activeMarket.name} วันที่ ${formatSessionDate(session.startsAt)} หรือไม่?`);
    if (!confirmed) return;
    await request(`/api/sessions/${encodeURIComponent(session.id)}/bookings`, { method: "POST", body: JSON.stringify({ boothId: booth.id }) });
    bookingNote.textContent = `จองพื้นที่ ${booth.code} สำเร็จ`;
    await loadBooths(session);
  } catch (error) {
    if (error.message.includes("เข้าสู่ระบบ") || error.message.includes("กรุณาเข้าสู่ระบบ")) {
      openAuth();
      authMessage.textContent = "เข้าสู่ระบบร้านค้าเพื่อจองพื้นที่ที่เลือก";
      return;
    }
    bookingNote.textContent = error.message;
  }
}

async function searchMarkets() {
  const query = searchInput.value.trim(); resultsElement.textContent = "กำลังค้นหาตลาด...";
  try { const params = new URLSearchParams(); if (query) params.set("q", query); params.set("limit", "100"); const data = await request(`/api/markets?${params}`); renderMarkets(data.items || []); return data.items || []; }
  catch (error) { showMessage("ค้นหาตลาดไม่ได้ในขณะนี้", error.message); return []; }
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  registerFields.hidden = !registering;
  document.querySelector("#shop-name").required = registering;
  document.querySelector("#shop-category").required = registering;
  document.querySelector("#auth-password").autocomplete = registering ? "new-password" : "current-password";
  authTitle.textContent = registering ? "สมัครร้านค้า" : "เข้าสู่ระบบ";
  authSubmit.textContent = registering ? "สมัครสมาชิก" : "เข้าสู่ระบบ";
  loginTab.classList.toggle("active", !registering); registerTab.classList.toggle("active", registering); authMessage.textContent = "";
}

function openAuth() { authDialog.showModal(); setAuthMode("login"); }
["#shop-entry", "#shop-entry-hero", "#shop-entry-banner"].forEach((selector) => document.querySelector(selector).addEventListener("click", () => {
  if (currentProfileRole) navigateProfile();
  else openAuth();
}));
document.querySelector("#close-auth").addEventListener("click", () => authDialog.close());
loginTab.addEventListener("click", () => setAuthMode("login")); registerTab.addEventListener("click", () => setAuthMode("register"));
authDialog.addEventListener("click", (event) => { if (event.target === authDialog) authDialog.close(); });

async function loadAccount() {
  try {
    const data = await request("/api/auth/me");
    currentProfileRole = data.user.role;
    currentAvatarData = data.user.avatarData || null;
    document.querySelector("#account-title").textContent = data.user.displayName;
    profileForm.elements.displayName.value = data.user.displayName || "";
    document.querySelector("#profile-email").value = data.user.email || "";
    profileRole.textContent = data.user.role === "admin" ? "ผู้ดูแลระบบ" : "ร้านค้า";
    shopProfileFields.hidden = data.user.role !== "shop";
    if (data.shop) {
      profileForm.elements.category.value = data.shop.category || "";
      profileForm.elements.description.value = data.shop.description || "";
      profileForm.elements.contactInfo.value = data.shop.contactInfo || "";
    }
    updateAvatarPreview(currentAvatarData, data.user.displayName);
    document.querySelectorAll("#shop-entry, #shop-entry-hero, #shop-entry-banner").forEach((button) => { button.textContent = "โปรไฟล์ของฉัน"; });
    return data;
  } catch (error) {
    accountPanel.hidden = true;
    currentProfileRole = null;
    updateAccountButtons(false);
  }
  return false;
}

function updateAvatarPreview(source, displayName = "") {
  avatarImage.hidden = !source;
  avatarImage.removeAttribute("src");
  if (source) avatarImage.src = source;
  avatarInitial.textContent = Array.from(displayName.trim())[0] || "ต";
  avatarInitial.hidden = Boolean(source);
}

function updateAccountButtons(isLoggedIn) {
  const labels = isLoggedIn
    ? ["โปรไฟล์ของฉัน", "โปรไฟล์ของฉัน", "โปรไฟล์ของฉัน"]
    : ["สำหรับร้านค้า", "ฉันเป็นร้านค้า", "เข้าสู่ระบบ / สมัครร้านค้า →"];
  ["#shop-entry", "#shop-entry-hero", "#shop-entry-banner"].forEach((selector, index) => {
    document.querySelector(selector).textContent = labels[index];
  });
}

async function navigateProfile(updateHistory = true) {
  const account = await loadAccount();
  if (!account) {
    returnToProfile = true;
    if (updateHistory && window.location.pathname !== "/profile") window.history.pushState({}, "", "/profile");
    openAuth();
    authMessage.textContent = "เข้าสู่ระบบเพื่อดูและแก้ไขโปรไฟล์";
    return;
  }
  returnToProfile = false;
  if (updateHistory && window.location.pathname !== "/profile") window.history.pushState({}, "", "/profile");
  document.querySelector("#home").hidden = true;
  accountPanel.hidden = false;
  accountPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function navigateHome(updateHistory = true) {
  if (updateHistory && window.location.pathname !== "/") window.history.pushState({}, "", "/");
  accountPanel.hidden = true;
  document.querySelector("#home").hidden = false;
  returnToProfile = false;
}

document.querySelector(".brand").addEventListener("click", (event) => {
  event.preventDefault();
  navigateHome();
});

document.querySelector("#profile-home").addEventListener("click", (event) => {
  event.preventDefault();
  navigateHome();
});

window.addEventListener("popstate", () => {
  if (window.location.pathname === "/profile") navigateProfile(false);
  else navigateHome(false);
});

avatarFile.addEventListener("change", async () => {
  const [file] = avatarFile.files || [];
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    profileMessage.textContent = "กรุณาเลือกรูป PNG, JPEG หรือ WebP";
    avatarFile.value = "";
    return;
  }
  try {
    const imageUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("อ่านไฟล์รูปไม่สำเร็จ"));
      reader.readAsDataURL(file);
    });
    const image = new Image();
    image.src = imageUrl;
    await image.decode();
    const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    let optimized = canvas.toDataURL("image/webp", 0.82);
    if (!optimized.startsWith("data:image/webp")) optimized = canvas.toDataURL("image/jpeg", 0.82);
    if (Math.ceil((optimized.length - optimized.indexOf(",") - 1) * 0.75) > 512 * 1024) throw new Error("รูปใหญ่เกินไป กรุณาเลือกรูปที่มีขนาดเล็กกว่า");
    currentAvatarData = optimized;
    updateAvatarPreview(currentAvatarData, profileForm.elements.displayName.value);
    profileMessage.textContent = "เลือกรูปแล้ว อย่าลืมกดบันทึกโปรไฟล์";
  } catch (error) {
    profileMessage.textContent = error.message || "เตรียมรูปโปรไฟล์ไม่สำเร็จ";
  }
});

document.querySelector("#remove-avatar").addEventListener("click", () => {
  currentAvatarData = null;
  avatarFile.value = "";
  updateAvatarPreview(null, profileForm.elements.displayName.value);
  profileMessage.textContent = "ลบรูปแล้ว อย่าลืมกดบันทึกโปรไฟล์";
});

profileForm.elements.displayName.addEventListener("input", () => {
  if (!currentAvatarData) updateAvatarPreview(null, profileForm.elements.displayName.value);
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault(); authMessage.textContent = "กำลังดำเนินการ..."; authSubmit.disabled = true;
  const values = Object.fromEntries(new FormData(authForm).entries());
  const payload = authMode === "register" ? values : { email: values.email, password: values.password };
  try {
    await request(`/api/auth/${authMode === "register" ? "register" : "login"}`, { method: "POST", body: JSON.stringify(payload) });
    if (authMode === "register") {
      setAuthMode("login"); authMessage.style.color = "#286553"; authMessage.textContent = "สมัครสำเร็จแล้ว เข้าสู่ระบบเพื่อเริ่มจัดการร้าน";
    } else {
      authDialog.close();
      await loadAccount();
      if (selectedBooth) {
        const pending = selectedBooth;
        selectedBooth = null;
        await reserveBooth(pending.session, pending.booth);
      } else if (returnToProfile || window.location.pathname === "/profile") await navigateProfile(false);
      else if (activeMarket && !marketDetail.hidden) await loadMarketCommunity();
    }
  } catch (error) { authMessage.style.color = "#a43e34"; authMessage.textContent = error.message; }
  finally { authSubmit.disabled = false; }
});

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault(); profileMessage.textContent = "กำลังบันทึก...";
  const values = Object.fromEntries(new FormData(profileForm).entries());
  const payload = { displayName: values.displayName, avatarData: currentAvatarData };
  if (currentProfileRole === "shop") Object.assign(payload, { category: values.category, description: values.description, contactInfo: values.contactInfo });
  try {
    await request("/api/profile", { method: "PATCH", body: JSON.stringify(payload) });
    document.querySelector("#account-title").textContent = values.displayName;
    profileMessage.style.color = "#286553";
    profileMessage.textContent = "บันทึกโปรไฟล์เรียบร้อยแล้ว";
    await loadAccount();
  }
  catch (error) { profileMessage.style.color = "#a43e34"; profileMessage.textContent = error.message; }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    await request("/api/auth/logout", { method: "POST" });
    accountPanel.hidden = true;
    currentProfileRole = null;
    updateAccountButtons(false);
    navigateHome();
    if (activeMarket && !marketDetail.hidden) await loadMarketCommunity();
    setStatus("ออกจากระบบแล้ว");
  }
  catch (error) { profileMessage.textContent = error.message; }
});

searchButton.addEventListener("click", searchMarkets);
searchInput.addEventListener("keydown", (event) => { if (event.key === "Enter") searchMarkets(); });

(async function initialize() {
  try { const health = await request("/api/health"); setStatus(health.database === "connected" ? "ระบบพร้อมใช้งาน" : "ระบบกำลังเตรียมพร้อม"); }
  catch (error) { setStatus("ระบบกำลังเชื่อมต่อ"); }
  const markets = await searchMarkets();
  const account = await loadAccount();
  if (window.location.pathname === "/profile") {
    if (account) {
      document.querySelector("#home").hidden = true;
      accountPanel.hidden = false;
    } else {
      returnToProfile = true;
      openAuth();
      authMessage.textContent = "เข้าสู่ระบบเพื่อดูและแก้ไขโปรไฟล์";
    }
  } else {
    const marketId = new URLSearchParams(window.location.search).get("market");
    const market = markets.find((item) => item.id === marketId);
    if (market) await openMarket(market);
  }
})();
