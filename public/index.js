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
let authMode = "login";

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
    const link = document.createElement("a"); link.className = "button"; link.textContent = "ดูตลาด";
    link.href = market.mapUrl || (market.mapToken ? `/map/${encodeURIComponent(market.mapToken)}` : "#markets");
    card.append(details, link); resultsElement.append(card);
  });
}

async function searchMarkets() {
  const query = searchInput.value.trim(); resultsElement.textContent = "กำลังค้นหาตลาด...";
  try { const params = new URLSearchParams(); if (query) params.set("q", query); const data = await request(`/api/markets?${params}`); renderMarkets(data.items || []); }
  catch (error) { showMessage("ค้นหาตลาดไม่ได้ในขณะนี้", error.message); }
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
["#shop-entry", "#shop-entry-hero", "#shop-entry-banner"].forEach((selector) => document.querySelector(selector).addEventListener("click", openAuth));
document.querySelector("#close-auth").addEventListener("click", () => authDialog.close());
loginTab.addEventListener("click", () => setAuthMode("login")); registerTab.addEventListener("click", () => setAuthMode("register"));
authDialog.addEventListener("click", (event) => { if (event.target === authDialog) authDialog.close(); });

async function loadAccount() {
  try {
    const data = await request("/api/auth/me");
    if (data.user.role !== "shop" || !data.shop) return;
    accountPanel.hidden = false;
    document.querySelector("#account-title").textContent = `สวัสดี ${data.shop.name}`;
    profileForm.elements.name.value = data.shop.name || "";
    profileForm.elements.category.value = data.shop.category || "";
    profileForm.elements.description.value = data.shop.description || "";
    profileForm.elements.contactInfo.value = data.shop.contactInfo || "";
    document.querySelectorAll("#shop-entry, #shop-entry-hero, #shop-entry-banner").forEach((button) => { button.textContent = "บัญชีร้านค้า"; button.onclick = () => accountPanel.scrollIntoView({ behavior: "smooth" }); });
    return true;
  } catch (error) { accountPanel.hidden = true; }
  return false;
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault(); authMessage.textContent = "กำลังดำเนินการ..."; authSubmit.disabled = true;
  const values = Object.fromEntries(new FormData(authForm).entries());
  const payload = authMode === "register" ? values : { email: values.email, password: values.password };
  try {
    await request(`/api/auth/${authMode === "register" ? "register" : "login"}`, { method: "POST", body: JSON.stringify(payload) });
    if (authMode === "register") {
      setAuthMode("login"); authMessage.style.color = "#286553"; authMessage.textContent = "สมัครสำเร็จแล้ว เข้าสู่ระบบเพื่อเริ่มจัดการร้าน";
    } else { authDialog.close(); await loadAccount(); accountPanel.scrollIntoView({ behavior: "smooth" }); }
  } catch (error) { authMessage.style.color = "#a43e34"; authMessage.textContent = error.message; }
  finally { authSubmit.disabled = false; }
});

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault(); profileMessage.textContent = "กำลังบันทึก...";
  const payload = Object.fromEntries(new FormData(profileForm).entries());
  try { const shop = await request("/api/shop/profile", { method: "PATCH", body: JSON.stringify(payload) }); document.querySelector("#account-title").textContent = `สวัสดี ${shop.name}`; profileMessage.style.color = "#286553"; profileMessage.textContent = "บันทึกข้อมูลร้านเรียบร้อยแล้ว"; }
  catch (error) { profileMessage.style.color = "#a43e34"; profileMessage.textContent = error.message; }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  try { await request("/api/auth/logout", { method: "POST" }); accountPanel.hidden = true; setStatus("ออกจากระบบแล้ว"); }
  catch (error) { profileMessage.textContent = error.message; }
});

searchButton.addEventListener("click", searchMarkets);
searchInput.addEventListener("keydown", (event) => { if (event.key === "Enter") searchMarkets(); });

(async function initialize() {
  try { const health = await request("/api/health"); setStatus(health.database === "connected" ? "ระบบพร้อมใช้งาน" : "ระบบกำลังเตรียมพร้อม"); }
  catch (error) { setStatus("ระบบกำลังเชื่อมต่อ"); }
  await searchMarkets();
  await loadAccount();
})();
