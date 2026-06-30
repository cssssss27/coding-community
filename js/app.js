const seedTables = window.CC_TABLES || {};

const db = {
  key: "codingCommunityTablesV10",
  mergeById(seedRows = [], savedRows = []) {
    if (!Array.isArray(savedRows)) return seedRows;
    const savedIds = new Set(savedRows.map(row => row?.id).filter(Boolean));
    return [
      ...savedRows,
      ...seedRows.filter(row => row?.id && !savedIds.has(row.id))
    ];
  },
  load() {
    const saved = localStorage.getItem(this.key);
    const base = JSON.parse(JSON.stringify(seedTables));
    base.workEngagements = Array.isArray(base.workEngagements) ? base.workEngagements : [];
    if (!saved) {
      localStorage.setItem(this.key, JSON.stringify(base));
      return base;
    }
    try {
      const savedTables = JSON.parse(saved);
      return {
        ...base,
        ...savedTables,
        works: this.mergeById(base.works, savedTables.works),
        users: this.mergeById(base.users, savedTables.users),
        workEngagements: Array.isArray(savedTables.workEngagements) ? savedTables.workEngagements : []
      };
    } catch {
      localStorage.setItem(this.key, JSON.stringify(base));
      return base;
    }
  },
  save(tables) {
    localStorage.setItem(this.key, JSON.stringify(tables));
  }
};

const authSessionVersionKey = "codingCommunityAuthVersion";

function formatApiConnectionError(base, error) {
  const message = String(error?.message || "");
  const isNetworkError =
    error instanceof TypeError ||
    /Failed to fetch|NetworkError|Load failed|ERR_CONNECTION_REFUSED/i.test(message);
  if (!isNetworkError) return error instanceof Error ? error : new Error(message || "服务器请求失败");
  const target = base || window.location.origin || "当前页面同源服务";
  const isLocalTarget = /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?/i.test(target);
  const hint = isLocalTarget
    ? "请确认已经启动 Start_Coding社区_服务器.bat，并使用 http://127.0.0.1:8010/ 访问网站。"
    : "请检查云端 /api/health、后端进程、反向代理超时和服务器到模型服务的出站网络。";
  return new Error(`无法连接 API 服务。${hint}当前请求目标：${target}`);
}

const serverApi = {
  base: window.CC_API_BASE || "",
  localBase: window.CC_LOCAL_API_BASE || "http://127.0.0.1:8010",
  tokenKey: "codingCommunityApiToken",
  adminTokenKey: "codingCommunityAdminApiToken",
  get token() {
    return localStorage.getItem(this.tokenKey) || "";
  },
  get adminToken() {
    return localStorage.getItem(this.adminTokenKey) || "";
  },
  setToken(token) {
    if (token) localStorage.setItem(this.tokenKey, token);
  },
  setAdminToken(token) {
    if (token) localStorage.setItem(this.adminTokenKey, token);
  },
  clearToken() {
    localStorage.removeItem(this.tokenKey);
  },
  clearAdminToken() {
    localStorage.removeItem(this.adminTokenKey);
  },
  isAvailable() {
    return this.candidateBases().length > 0;
  },
  candidateBases() {
    const bases = [];
    const isLocalPage = ["localhost", "127.0.0.1", ""].includes(location.hostname);
    if (this.base) bases.push(this.base);
    if (location.protocol === "http:" || location.protocol === "https:") bases.push("");
    if (this.localBase && (isLocalPage || location.protocol === "file:")) bases.push(this.localBase);
    return [...new Set(bases.map(base => String(base || "").replace(/\/$/, "")))];
  },
  async request(path, options = {}) {
    if (!this.isAvailable()) throw new Error("server api unavailable");
    const bases = this.candidateBases();
    let lastError = null;
    for (const base of bases) {
      const headers = new Headers(options.headers || {});
      if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
      try {
        const response = await fetch(`${base}${path}`, { ...options, headers });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const apiError = new Error(payload.detail || "服务器请求失败");
          apiError.status = response.status;
          apiError.fromApiResponse = true;
          if (response.status === 404 && base !== bases[bases.length - 1]) {
            lastError = apiError;
            continue;
          }
          throw apiError;
        }
        if (base && base === this.localBase) this.base = base;
        return payload;
      } catch (error) {
        if (error?.fromApiResponse) throw error;
        lastError = formatApiConnectionError(base, error);
      }
    }
    throw lastError || new Error("服务器请求失败");
  },
  bootstrap() {
    return this.request("/api/bootstrap");
  },
  getWork(id) {
    return this.request(`/api/works/${encodeURIComponent(id)}`);
  },
  createVibeSession(workId) {
    return this.request("/api/vibe/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workId })
    });
  },
  sendVibeMessage(sessionId, prompt) {
    return this.request(`/api/vibe/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt })
    });
  },
  saveVibeSession(sessionId, data) {
    const isFormData = data instanceof FormData;
    return this.request(`/api/vibe/sessions/${encodeURIComponent(sessionId)}/save`, {
      method: "POST",
      headers: isFormData ? {} : { "Content-Type": "application/json" },
      body: isFormData ? data : JSON.stringify(data || {})
    });
  },
  setWorkEngagement(workId, kind, active) {
    return this.request(`/api/works/${encodeURIComponent(workId)}/engagements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, active })
    });
  },
  recordWorkEvent(workId, kind) {
    return this.request(`/api/works/${encodeURIComponent(workId)}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind })
    });
  },
  login(data) {
    return this.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: data.identifier, password: data.password })
    });
  },
  register(data) {
    return this.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: data.phone,
        name: data.name,
        email: data.email || "",
        avatar: data.avatar || "",
        password: data.password,
        signature: data.signature || "",
        field: data.field || ""
      })
    });
  },
  providerLogin(provider) {
    return this.request("/api/auth/provider-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: provider.id, label: provider.label })
    });
  },
  updateProfile(data) {
    return this.request("/api/me/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
  },
  createWork(formData) {
    return this.request("/api/works", {
      method: "POST",
      body: formData
    });
  },
  adminLogin(data) {
    return this.request("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: data.username, password: data.password })
    });
  },
  updateAdminWork(id, data) {
    return this.request(`/api/admin/works/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Admin-Token": this.adminToken },
      body: JSON.stringify(data)
    });
  },
  deleteAdminWork(id) {
    return this.request(`/api/admin/works/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "X-Admin-Token": this.adminToken }
    });
  },
  updateAdminUser(id, data) {
    return this.request(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Admin-Token": this.adminToken },
      body: JSON.stringify(data)
    });
  },
  deleteAdminUser(id) {
    return this.request(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "X-Admin-Token": this.adminToken }
    });
  },
  updateAdminApiConfig(id, data) {
    return this.request(`/api/admin/api-configs/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Admin-Token": this.adminToken },
      body: JSON.stringify(data)
    });
  },
  checkAdminApiConfig(id, data = {}) {
    return this.request(`/api/admin/api-configs/${encodeURIComponent(id)}/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": this.adminToken },
      body: JSON.stringify(data)
    });
  },
  updateUploadCopyPrompts(data) {
    return this.request("/api/admin/upload-copy-prompts", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Admin-Token": this.adminToken },
      body: JSON.stringify(data)
    });
  },
  generateUploadCopy(data) {
    return this.request("/api/ai/upload-copy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
  },
  createAdminPointRecord(data) {
    return this.request("/api/admin/points-records", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": this.adminToken },
      body: JSON.stringify(data)
    });
  },
  updateAdminSettings(data) {
    return this.request("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Admin-Token": this.adminToken },
      body: JSON.stringify(data)
    });
  }
};

function upsertById(rows, row) {
  if (!row || !row.id) return rows;
  const index = rows.findIndex(item => item.id === row.id);
  if (index >= 0) rows[index] = { ...rows[index], ...row };
  else rows.unshift(row);
  return rows;
}

function applyAuthPayload(payload) {
  if (!payload?.user) return null;
  serverApi.setToken(payload.token);
  upsertById(app.tables.users, payload.user);
  if (Array.isArray(payload.workEngagements)) app.tables.workEngagements = payload.workEngagements;
  db.save(app.tables);
  app.setCurrentUser(payload.user.id);
  return payload.user;
}

const app = {
  tables: db.load(),
  serverReady: false,
  async initBackend() {
    try {
      const payload = await serverApi.bootstrap();
      this.serverReady = true;
      if (Array.isArray(payload.settings) && payload.settings.length) this.tables.settings = payload.settings;
      if (Array.isArray(payload.categories) && payload.categories.length) this.tables.categories = payload.categories;
      if (Array.isArray(payload.users)) this.tables.users = payload.users;
      if (Array.isArray(payload.works)) this.tables.works = payload.works;
      if (Array.isArray(payload.ads) && payload.ads.length) this.tables.ads = payload.ads;
      if (Array.isArray(payload.apiConfigs) && payload.apiConfigs.length) this.tables.apiConfigs = payload.apiConfigs;
      if (Array.isArray(payload.pointsRecords)) this.tables.pointsRecords = payload.pointsRecords;
      if (Array.isArray(payload.workEngagements)) this.tables.workEngagements = payload.workEngagements;
      if (payload.currentUser) {
        upsertById(this.tables.users, payload.currentUser);
        this.setCurrentUser(payload.currentUser.id);
      }
      db.save(this.tables);
    } catch {
      this.serverReady = false;
    }
  },
  async ensureBackendReady() {
    if (this.serverReady) return true;
    await this.initBackend();
    return this.serverReady;
  },
  qs(name) {
    return new URLSearchParams(location.search).get(name);
  },
  site() {
    return this.tables.settings.find(row => row.id === "site") || {};
  },
  adminAuth() {
    return this.tables.settings.find(row => row.id === "adminAuth") || { username: "admin", password: "admin1212" };
  },
  uploadCopyPrompts() {
    return this.tables.settings.find(row => row.id === "uploadCopyPrompts") || {};
  },
  isLoggedIn() {
    const id = localStorage.getItem("codingCommunityCurrentUser");
    if (this.serverReady && !serverApi.token) return false;
    const isValidSession =
      localStorage.getItem("codingCommunityAuthSession") === "true" &&
      localStorage.getItem(authSessionVersionKey) === db.key;
    return Boolean(isValidSession && id && this.tables.users.some(user => user.id === id));
  },
  currentUser() {
    const id = localStorage.getItem("codingCommunityCurrentUser");
    return this.tables.users.find(user => user.id === id) || this.tables.users.find(user => user.id === "u-demo") || this.tables.users[0];
  },
  setCurrentUser(id) {
    localStorage.setItem("codingCommunityCurrentUser", id);
    localStorage.setItem("codingCommunityAuthSession", "true");
    localStorage.setItem(authSessionVersionKey, db.key);
  },
  logout() {
    serverApi.clearToken();
    localStorage.removeItem("codingCommunityCurrentUser");
    localStorage.removeItem("codingCommunityAuthSession");
    localStorage.removeItem(authSessionVersionKey);
  },
  findWork(id) {
    return this.tables.works.find(work => work.id === id) || this.tables.works[0];
  },
  async ensureWorkDetail(id) {
    const cached = this.findWork(id);
    if (!this.serverReady || !cached?.id || cached.html) return cached;
    try {
      const payload = await serverApi.getWork(cached.id);
      if (payload?.work) {
        upsertById(this.tables.works, payload.work);
        this.save();
        return payload.work;
      }
    } catch {
      return cached;
    }
    return cached;
  },
  save() {
    db.save(this.tables);
  },
  toast(message, type = "info") {
    document.querySelectorAll(".toast").forEach(item => item.remove());
    const node = document.createElement("div");
    node.className = `toast ${type ? `toast-${type}` : ""}`.trim();
    node.textContent = message;
    document.body.appendChild(node);
    setTimeout(() => node.remove(), 3200);
  },
  writeFrame(frame, html) {
    frame.srcdoc = html || "<!doctype html><html><body></body></html>";
  }
};

const avatarOptions = [
  { id: "dog", src: "images/avatars/avatar-dog.png", label: "狗哥" },
  { id: "deer", src: "images/avatars/avatar-deer.png", label: "鹿叔" },
  { id: "giraffe", src: "images/avatars/avatar-giraffe.png", label: "大个" },
  { id: "frog", src: "images/avatars/avatar-frog.png", label: "红颜" }
];

const authProviders = [
  { id: "wechat", label: "微信", icon: "images/icons/wechat.svg" },
  { id: "qq", label: "QQ", icon: "images/icons/qq.svg" },
  { id: "weibo", label: "微博", icon: "images/icons/weibo.svg" },
  { id: "google", label: "Google", icon: "images/icons/google.svg" },
  { id: "github", label: "GitHub", icon: "images/icons/github.svg" }
];

const domainOptions = ["AI 实验", "效率工具", "数据可视化", "运营后台", "教育工具", "创意组件", "设计工具", "开发者工具", "电商营销", "个人作品集"];
const accountTypeOptions = ["个人创作者", "团队管理员", "企业成员", "学生/研究者", "品牌方", "投资/媒体观察者"];
const subscriptionPlanOptions = ["Free", "Pro", "Team", "Enterprise"];
const subscriptionStatusOptions = ["free", "trialing", "active", "past_due", "canceled"];
const defaultWorkCategories = ["创意组件", "AI 实验", "效率工具", "设计工具", "教育工具", "数据可视化", "运营后台", "电商营销", "活动运营", "文旅工具", "生活工具", "艺术展览"];
const legacyCategorySlots = {
  "互动视觉": 0,
  "音乐工具": 0,
  "视觉实验": 3,
  "品牌视觉": 3,
  "知识卡片": 4,
  "知识管理": 4,
  "文博工具": 9,
  "自然观察": 10,
  "身心灵": 10
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.name) return resolve("");
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", reject);
    reader.readAsDataURL(file);
  });
}

function splitTags(value) {
  return String(value || "").split(/[,，\s]+/).map(item => item.trim()).filter(Boolean).slice(0, 8);
}

function splitLines(value) {
  return String(value || "").split(/\r?\n/).map(item => item.trim()).filter(Boolean).slice(0, 8);
}

function normalizeHandle(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function uniqueHandle(base) {
  const clean = normalizeHandle(base) || `user_${Date.now().toString(36)}`;
  let candidate = clean;
  let index = 2;
  while (app.tables.users.some(user => String(user.username || "").toLowerCase() === candidate)) {
    candidate = `${clean}_${index}`;
    index += 1;
  }
  return candidate;
}

function splitList(value) {
  if (Array.isArray(value)) return value;
  return String(value || "")
    .split(/[,\s，、]+/)
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function joinList(value) {
  return Array.isArray(value) ? value.join("，") : String(value || "");
}

function optionList(options, selected) {
  return options.map(item => `<option value="${escapeHtml(item)}" ${item === selected ? "selected" : ""}>${escapeHtml(item)}</option>`).join("");
}

function avatarPicker(name, selected, { allowUpload = false } = {}) {
  const current = selected || avatarOptions[0].src;
  const isCustom = current && !avatarOptions.some(avatar => avatar.src === current);
  return `
    <div class="avatar-picker full" data-avatar-picker="${escapeHtml(name)}">
      ${avatarOptions.map(avatar => `
        <label class="avatar-option ${avatar.src === current ? "selected" : ""}">
          <input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(avatar.src)}" ${avatar.src === current ? "checked" : ""}>
          <img src="${escapeHtml(avatar.src)}" alt="${escapeHtml(avatar.label)}" loading="lazy" decoding="async">
          <span>${escapeHtml(avatar.label)}</span>
        </label>
      `).join("")}
      ${allowUpload ? `
        <label class="avatar-option avatar-upload-option ${isCustom ? "selected" : ""}">
          <input class="custom-avatar-radio" type="radio" name="${escapeHtml(name)}" value="${isCustom ? escapeHtml(current) : ""}" ${isCustom ? "checked" : ""}>
          <input class="avatar-file-input" type="file" accept="image/*" data-avatar-upload="${escapeHtml(name)}">
          <span class="avatar-plus" aria-hidden="true">${isCustom ? `<img src="${escapeHtml(current)}" alt="" loading="lazy" decoding="async">` : "+"}</span>
          <span>上传</span>
        </label>
      ` : ""}
    </div>
  `;
}

function syncAvatarPicker(picker, option) {
  if (!picker || !option) return;
  const radio = option.querySelector('input[type="radio"]');
  if (!radio || !radio.value) return;
  radio.checked = true;
  picker.querySelectorAll(".avatar-option").forEach(item => {
    item.classList.toggle("selected", item === option);
  });
  const profileAvatar = picker.closest("form")?.parentElement?.querySelector(".profile-avatar");
  if (profileAvatar) profileAvatar.src = radio.value;
}

function wireAvatarPicker(scope = document) {
  scope.querySelectorAll(".avatar-picker").forEach(picker => {
    picker.querySelectorAll(".avatar-option").forEach(option => {
      const radio = option.querySelector('input[type="radio"]');
      if (!radio) return;
      option.addEventListener("click", event => {
        if (event.target.matches(".avatar-file-input")) return;
        syncAvatarPicker(picker, option);
      });
      radio.addEventListener("change", () => syncAvatarPicker(picker, option));
    });
  });
}

function wireAvatarUpload(scope = document) {
  scope.querySelectorAll("[data-avatar-upload]").forEach(input => {
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) return app.toast("请选择图片文件。");
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        const option = input.closest(".avatar-upload-option");
        const picker = input.closest(".avatar-picker");
        const radio = option?.querySelector(".custom-avatar-radio");
        const plus = option?.querySelector(".avatar-plus");
        if (!option || !picker || !radio || !plus) return;
        radio.value = String(reader.result || "");
        radio.checked = true;
        plus.innerHTML = `<img src="${escapeHtml(radio.value)}" alt="" loading="lazy" decoding="async">`;
        syncAvatarPicker(picker, option);
      });
      reader.readAsDataURL(file);
    });
  });
}

function buildUserFromRegistration(data) {
  const phone = String(data.phone || "").trim();
  const nickname = String(data.name || "").trim();
  const now = new Date().toLocaleString("zh-CN", { hour12: false });
  return {
    id: makeId("u"),
    username: phone,
    name: nickname,
    avatar: data.avatar || avatarOptions[0].src,
    email: String(data.email || "").trim().toLowerCase(),
    phone,
    password: String(data.password || ""),
    role: "creator",
    accountType: "个人创作者",
    title: "",
    organization: "",
    field: "创意组件",
    location: "",
    website: "",
    github: "",
    weibo: "",
    bio: "",
    signature: "",
    skills: [],
    interests: [],
    language: "zh-CN",
    timezone: "Asia/Shanghai",
    visibility: data.visibility || "public",
    newsletter: true,
    termsAccepted: true,
    loginProvider: "email",
    lastLoginAt: now,
    lastActiveAt: now,
    activityScore: 35,
    subscriptionPlan: "Free",
    subscriptionStatus: "free",
    subscriptionRenewAt: "",
    points: 100,
    joinedAt: new Date().toISOString().slice(0, 10)
  };
}

function normalizeCategoryNames(names) {
  const raw = Array.isArray(names) ? names : [];
  const result = [];
  defaultWorkCategories.forEach((fallback, index) => {
    let candidate = String(raw[index] || "").trim() || fallback;
    if (result.includes(candidate)) candidate = fallback;
    if (result.includes(candidate)) candidate = defaultWorkCategories.find(item => !result.includes(item)) || fallback;
    result.push(candidate);
  });
  return result.slice(0, 12);
}

function appCategories() {
  if (Array.isArray(app.tables.categories) && app.tables.categories.length) return normalizeCategoryNames(app.tables.categories);
  const setting = app.tables.settings.find(row => row.id === "workCategories");
  return normalizeCategoryNames(setting?.categories);
}

function categorySlotIndex(value, categories = appCategories()) {
  const name = String(value || "").trim();
  if (!name) return -1;
  if (categories.includes(name)) return categories.indexOf(name);
  if (defaultWorkCategories.includes(name)) return defaultWorkCategories.indexOf(name);
  return Object.prototype.hasOwnProperty.call(legacyCategorySlots, name) ? legacyCategorySlots[name] : -1;
}

function normalizeWorkCategories(values, categories = appCategories()) {
  const raw = Array.isArray(values) ? values : String(values || "").split(/[,，、|/\s]+/);
  const result = [];
  raw.forEach(value => {
    const index = categorySlotIndex(value, categories);
    if (index < 0 || index >= categories.length) return;
    const name = categories[index];
    if (!result.includes(name)) result.push(name);
  });
  return (result.length ? result : [categories[0]]).slice(0, 3);
}

function workCategories(work) {
  return normalizeWorkCategories(Array.isArray(work.categories) && work.categories.length ? work.categories : [work.category]);
}

function workPrimaryCategory(work) {
  return workCategories(work)[0];
}

function workInCategory(work, category) {
  return !category || workCategories(work).includes(category);
}

function categoryOptions() {
  return appCategories();
}

function renderCategorySelects(selected = [], { requiredFirst = true } = {}) {
  const hasSelection = Array.isArray(selected) ? selected.filter(Boolean).length : Boolean(selected);
  const chosen = hasSelection ? normalizeWorkCategories(selected) : [];
  const categories = appCategories();
  return [0, 1, 2].map(index => {
    const value = chosen[index] || "";
    const empty = index === 0
      ? `<option value="" ${value ? "" : "selected"} ${requiredFirst ? "disabled" : ""}>请选择分类</option>`
      : `<option value="">可选分类</option>`;
    return `
      <select class="field category-select" name="categories" ${index === 0 && requiredFirst ? "required" : ""} data-category-select="${index + 1}">
        ${empty}
        ${categories.map(category => `<option value="${escapeHtml(category)}" ${category === value ? "selected" : ""}>${escapeHtml(category)}</option>`).join("")}
      </select>
    `;
  }).join("");
}

function renderUploadCategoryButtons(selected = []) {
  const categories = appCategories();
  const chosen = normalizeWorkCategories(selected.length ? selected : [categories[0]], categories);
  return `
    <div class="upload-category-grid" role="group" aria-label="作品分类">
      ${categories.map(category => {
        const active = chosen.includes(category);
        return `<button class="upload-category-button ${active ? "active" : ""}" type="button" data-upload-category="${escapeHtml(category)}" aria-pressed="${active ? "true" : "false"}">${escapeHtml(category)}</button>`;
      }).join("")}
    </div>
    <p class="upload-category-hint"><span data-upload-category-count>${chosen.length}</span>/3 已选，最少选择 1 个分类</p>
  `;
}

function uploadCategorySelection(scope) {
  return Array.from(scope.querySelectorAll("[data-upload-category].active"))
    .map(button => button.dataset.uploadCategory || "")
    .filter(Boolean);
}

function syncUploadCategoryButtons(scope) {
  const values = normalizeWorkCategories(uploadCategorySelection(scope));
  scope.querySelectorAll("[data-upload-category]").forEach(button => {
    const active = values.includes(button.dataset.uploadCategory || "");
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const counter = scope.querySelector("[data-upload-category-count]");
  if (counter) counter.textContent = String(values.length);
}

function selectedCategoriesFrom(scope) {
  const uploadButtons = Array.from(scope.querySelectorAll("[data-upload-category].active"));
  if (uploadButtons.length) return normalizeWorkCategories(uploadButtons.map(button => button.dataset.uploadCategory || ""));
  const values = Array.from(scope.querySelectorAll('[name="categories"]'))
    .map(input => input.value.trim())
    .filter(Boolean);
  return values.length ? normalizeWorkCategories(values) : [];
}

function isWorkPublished(work) {
  return (work.status || "published") === "published";
}

function workStatusLabel(status) {
  return {
    published: "已发布",
    reviewing: "审核中",
    hidden: "已隐藏"
  }[status || "published"] || "已发布";
}

function workMatches(work, term, category = "全部分类") {
  const categories = workCategories(work);
  const searchable = [work.title, work.author, ...categories, work.description, ...(work.tags || [])].join(" ").toLowerCase();
  const matchesCategory = category === "全部分类" || workInCategory(work, category);
  return isWorkPublished(work) && matchesCategory && (!term || searchable.includes(term));
}

function workPreviewUrl(id) {
  return `${serverApi.base}/api/works/${encodeURIComponent(id)}/preview`;
}

function vibePreviewUrl(session) {
  const url = session?.previewUrl || "";
  return url ? `${serverApi.base}${url}` : "about:blank";
}

function grantPreviewFramePermissions(frame) {
  if (!frame) return;
  frame.setAttribute("allow", "camera; microphone; fullscreen; autoplay; clipboard-read; clipboard-write");
  frame.setAttribute("allowfullscreen", "");
  if (frame.hasAttribute("sandbox")) {
    const sandboxTokens = new Set(String(frame.getAttribute("sandbox") || "").split(/\s+/).filter(Boolean));
    [
      "allow-scripts",
      "allow-forms",
      "allow-same-origin",
      "allow-pointer-lock",
      "allow-modals",
      "allow-downloads",
      "allow-popups",
      "allow-top-navigation-by-user-activation"
    ].forEach(token => sandboxTokens.add(token));
    frame.setAttribute("sandbox", Array.from(sandboxTokens).join(" "));
  }
}

function loadStaticPreviewFallback(frame, html) {
  grantPreviewFramePermissions(frame);
  app.writeFrame(frame, html);
}

const modelThinkingSteps = [
  "正在读取作品结构",
  "正在理解修改指令",
  "正在生成新版程序",
  "正在准备预览"
];

function createModelProgressMessage() {
  return {
    role: "assistant",
    content: "模型正在 coding，请稍候。",
    progress: true
  };
}

function requiredLabel(text) {
  return `${escapeHtml(text)}<b class="required-star" aria-hidden="true">*</b>`;
}

function validateWorkSubmissionForm(form, { requireProgramFile = false } = {}) {
  const data = new FormData(form);
  const requireText = (name, message) => {
    const field = form.elements[name];
    if (String(data.get(name) || "").trim()) return true;
    app.toast(message, "error");
    field?.focus();
    return false;
  };
  if (!requireText("title", "请填写作品名称")) return false;
  if (!selectedCategoriesFrom(form).length) return app.toast("请选择 1-3 个作品分类", "error"), false;
  if (!requireText("author", "请填写作者显示名")) return false;
  if (!requireText("description", "请填写一句话简介")) return false;
  if (!splitTags(data.get("tags")).length) {
    app.toast("请填写标签", "error");
    form.elements.tags?.focus();
    return false;
  }
  const coverFile = form.elements.cover?.files?.[0];
  if (!coverFile || !coverFile.name) {
    app.toast("请选择作品封面图", "error");
    form.elements.cover?.focus();
    return false;
  }
  if (requireProgramFile) {
    const htmlFile = form.elements.file?.files?.[0];
    if (!htmlFile || !htmlFile.name) {
      app.toast("请选择 HTML 程序文件", "error");
      form.elements.file?.focus();
      return false;
    }
  }
  return true;
}

const uploadCopyTargetLabels = {
  highlights: "功能亮点",
  useCases: "适用场景",
  creatorNote: "作者说明"
};

function appendSelectedCategories(data, scope) {
  data.delete("categories");
  selectedCategoriesFrom(scope).forEach(category => data.append("categories", category));
  return data;
}

function wireCategoryButtonPicker(categoryList, onChange = () => {}) {
  categoryList.addEventListener("click", event => {
    const button = event.target.closest("[data-upload-category]");
    if (!button) return;
    const selected = uploadCategorySelection(categoryList);
    const isActive = button.classList.contains("active");
    if (!isActive && selected.length >= 3) {
      app.toast("最多选择 3 个作品分类", "error");
      return;
    }
    if (isActive && selected.length <= 1) {
      app.toast("至少选择 1 个作品分类", "error");
      return;
    }
    button.classList.toggle("active", !isActive);
    syncUploadCategoryButtons(categoryList);
    onChange();
  });
}

function askVariantSubmission(work) {
  return new Promise(resolve => {
    const user = app.currentUser();
    const modal = document.createElement("div");
    modal.className = "save-title-modal variant-submit-modal";
    modal.innerHTML = `
      <div class="save-title-backdrop" data-close-save-title></div>
      <section class="save-title-dialog variant-submit-dialog" role="dialog" aria-modal="true" aria-label="保存为新作品">
        <button class="modal-close" type="button" data-close-save-title>关闭</button>
        <p class="kicker">Publish</p>
        <h2>保存为新作品</h2>
        <p>基于「${escapeHtml(work.title)}」生成的新程序会作为 HTML 程序文件保存。请像正式提交作品一样补齐发布信息。</p>
        <form id="variant-save-form" class="save-title-form variant-save-form">
          <label class="field-group full">
            <span data-required-label>${requiredLabel("作品名称")}</span>
            <input class="field" name="title" maxlength="40" placeholder="请输入新的作品名称" autocomplete="off" required>
          </label>
          <div class="field-group full">
            <span data-required-label>${requiredLabel("作品分类")}</span>
            <div class="upload-category-picker" id="variant-save-categories" aria-label="作品分类，最少选择 1 个，最多选择 3 个">
              ${renderUploadCategoryButtons(workCategories(work))}
            </div>
          </div>
          <label class="field-group">
            <span data-required-label>${requiredLabel("作者显示名")}</span>
            <input class="field" name="author" value="${escapeHtml(user?.name || "")}" placeholder="请输入作者显示名" required>
          </label>
          <div class="field-group">
            <span>是否有偿做同款</span>
            <div class="paid-trial-control" role="radiogroup" aria-label="是否有偿做同款">
              <label><input type="radio" name="paidTrial" value="false" ${isPaidWork(work) ? "" : "checked"}> 否</label>
              <label><input type="radio" name="paidTrial" value="true" ${isPaidWork(work) ? "checked" : ""}> 是</label>
            </div>
          </div>
          <label class="field-group full">
            <span data-required-label>${requiredLabel("一句话简介")}</span>
            <textarea class="field textarea small" name="description" placeholder="说明这个衍生程序解决什么问题、适合谁使用。" required></textarea>
          </label>
          <label class="field-group full">
            <span data-required-label>${requiredLabel("标签")}</span>
            <input class="field" name="tags" placeholder="用逗号分隔，例如：运营, 同款, HTML" required>
          </label>
          <label class="field-group">
            <span data-required-label>${requiredLabel("作品封面图")}</span>
            <input class="field" name="cover" type="file" accept="image/*" required>
          </label>
          <label class="field-group">
            <span data-required-label>${requiredLabel("HTML 程序文件")}</span>
            <input class="field readonly-field" value="当前预览程序将作为 HTML 文件保存" readonly>
          </label>
          <label class="field-group full">
            <span>版本标记</span>
            <input class="field" name="version" placeholder="v1.0 / remix / 内测版">
          </label>
          <label class="field-group full">
            <span>功能亮点</span>
            <textarea class="field textarea" name="highlights" placeholder="每行一条"></textarea>
          </label>
          <label class="field-group full">
            <span>适用场景</span>
            <textarea class="field textarea" name="useCases" placeholder="每行一条"></textarea>
          </label>
          <label class="field-group full">
            <span>作者说明</span>
            <textarea class="field textarea small" name="creatorNote" placeholder="可写修改说明、授权说明或后续计划。"></textarea>
          </label>
          <div class="variant-cover-preview full" id="variant-cover-preview">封面预览</div>
          <button class="nav-button solid full" type="submit">发布新作品</button>
        </form>
      </section>
    `;
    const close = value => {
      modal.remove();
      resolve(value);
    };
    document.body.appendChild(modal);
    const input = modal.querySelector('[name="title"]');
    setTimeout(() => input?.focus(), 0);
    modal.querySelectorAll("[data-close-save-title]").forEach(item => {
      item.addEventListener("click", () => close(null));
    });
    const form = modal.querySelector("#variant-save-form");
    const categoryList = modal.querySelector("#variant-save-categories");
    const coverPreview = modal.querySelector("#variant-cover-preview");
    wireCategoryButtonPicker(categoryList);
    form.elements.cover?.addEventListener("change", async () => {
      const file = form.elements.cover?.files?.[0];
      coverPreview.innerHTML = file ? `<img src="${escapeHtml(await fileToDataUrl(file))}" alt="封面预览">` : "封面预览";
    });
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!validateWorkSubmissionForm(form)) return;
      close(appendSelectedCategories(new FormData(form), form));
    });
  });
}

const thumbRatioPresets = ["4 / 5", "3 / 4", "1 / 1", "5 / 6", "4 / 3", "7 / 9", "6 / 7"];

function workThumbRatio(work) {
  const explicit = String(work.thumbRatio || "").match(/^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/);
  if (explicit) return `${explicit[1]} / ${explicit[2]}`;
  const width = Number(work.imageWidth || work.coverWidth || 0);
  const height = Number(work.imageHeight || work.coverHeight || 0);
  if (width > 0 && height > 0) return `${width} / ${height}`;
  const source = String(work.id || work.image || work.title || "work");
  const seed = source.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return thumbRatioPresets[seed % thumbRatioPresets.length];
}

function workPopularity(work) {
  const views = Number(work.viewCount || work.views || 0);
  const likes = Number(work.likeCount || work.likes || 0);
  const favorites = Number(work.favoriteCount || work.favorites || 0);
  const trials = Number(work.trialCount || work.trials || 0);
  const vibes = Number(work.vibeCount || work.copyCount || work.forkCount || work.remixCount || 0);
  return Math.max(0, Math.round(views * 0.10 + likes * 0.30 + favorites * 0.15 + trials * 0.15 + vibes * 0.30));
}

function isPaidWork(work) {
  return Boolean(work?.paidTrial || work?.paid || work?.isPaid);
}

function workAccessState(work) {
  const paid = isPaidWork(work);
  return paid
    ? { mode: "paid", title: "会员作品", copy: "免费试用程序，会员开放做同款" }
    : { mode: "free", title: "开放作品", copy: "试用程序与做同款免费开放" };
}

function workAccessMarkup(work) {
  const access = workAccessState(work);
  return `
    <div class="work-access-card is-${access.mode}" aria-label="${escapeHtml(access.title)}">
      <strong class="work-access-title">${escapeHtml(access.title)}</strong>
      <span class="work-access-copy">${escapeHtml(access.copy)}</span>
    </div>
  `;
}

function derivativeLabel(work) {
  const generation = Number(work.derivativeGeneration || 0);
  const originalTitle = work.originalWorkTitle || work.originWorkTitle || "";
  return generation > 0 && originalTitle ? `《${originalTitle}》的第${generation}代衍生` : "";
}

function workEngagements() {
  if (!Array.isArray(app.tables.workEngagements)) app.tables.workEngagements = [];
  return app.tables.workEngagements;
}

function hasWorkEngagement(workId, kind) {
  if (!app.isLoggedIn()) return false;
  const userId = app.currentUser()?.id;
  return workEngagements().some(item => item.workId === workId && item.kind === kind && (!item.userId || item.userId === userId));
}

function setLocalWorkEngagement(workId, kind, active) {
  const user = app.currentUser();
  if (!user?.id) return;
  app.tables.workEngagements = workEngagements().filter(item => !(item.workId === workId && item.kind === kind && (!item.userId || item.userId === user.id)));
  if (active) app.tables.workEngagements.unshift({ userId: user.id, workId, kind, createdAt: new Date().toISOString() });
  const work = app.findWork(workId);
  if (work?.id) {
    const field = kind === "like" ? "likeCount" : "favoriteCount";
    work[field] = Math.max(0, Number(work[field] || 0) + (active ? 1 : -1));
  }
}

function engagementButton(work, kind, icon, label) {
  const active = hasWorkEngagement(work.id, kind);
  const count = Number(kind === "like" ? work.likeCount || 0 : work.favoriteCount || 0);
  return `
    <button class="work-engagement-button ${active ? "active" : ""}" type="button" data-work-engagement="${kind}" data-work-id="${escapeHtml(work.id)}" aria-pressed="${active}" aria-label="${escapeHtml(label)} ${count}" title="${escapeHtml(label)}">
      <span aria-hidden="true">${icon}</span><strong>${count}</strong>
    </button>
  `;
}

function workEngagementActions(work, variant = "") {
  return `
    <div class="work-engagement-actions ${variant ? `is-${variant}` : ""}" aria-label="作品互动">
      ${engagementButton(work, "like", "♡", "点赞")}
      ${engagementButton(work, "favorite", "☆", "收藏")}
    </div>
  `;
}

function refreshWorkEngagementButtons(workId) {
  const work = app.findWork(workId);
  if (!work?.id) return;
  document.querySelectorAll(`[data-work-id="${CSS.escape(workId)}"][data-work-engagement]`).forEach(button => {
    const kind = button.dataset.workEngagement;
    const active = hasWorkEngagement(workId, kind);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
    const count = Number(kind === "like" ? work.likeCount || 0 : work.favoriteCount || 0);
    const countNode = button.querySelector("strong");
    if (countNode) countNode.textContent = String(count);
  });
}

async function toggleWorkEngagement(workId, kind) {
  if (!app.isLoggedIn()) {
    openAuthModal({ mode: "login", afterLogin: currentPageTarget() });
    return;
  }
  const active = !hasWorkEngagement(workId, kind);
  if (app.serverReady) {
    const payload = await serverApi.setWorkEngagement(workId, kind, active);
    if (payload.work) upsertById(app.tables.works, payload.work);
    if (Array.isArray(payload.workEngagements)) app.tables.workEngagements = payload.workEngagements;
  } else {
    setLocalWorkEngagement(workId, kind, active);
  }
  app.save();
  refreshWorkEngagementButtons(workId);
}

async function recordWorkMetric(workId, kind) {
  const fieldByKind = { view: "viewCount", trial: "trialCount", vibe: "vibeCount" };
  const field = fieldByKind[kind];
  const work = app.findWork(workId);
  if (!work?.id || !field) return;
  work[field] = Math.max(0, Number(work[field] || 0) + 1);
  app.save();
  if (!app.serverReady) return;
  try {
    const payload = await serverApi.recordWorkEvent(workId, kind);
    if (payload.work) upsertById(app.tables.works, payload.work);
    app.save();
  } catch {
    // Metrics are non-blocking; interaction and preview should remain usable.
  }
}

function wireWorkEngagements() {
  document.addEventListener("click", async event => {
    const button = event.target.closest("[data-work-engagement]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    try {
      await toggleWorkEngagement(button.dataset.workId, button.dataset.workEngagement);
    } catch (error) {
      app.toast(error.message || "互动保存失败");
    } finally {
      button.disabled = false;
    }
  });
}

function workCard(work, { eager = false } = {}) {
  const heat = workPopularity(work);
  const imageLoading = eager ? "eager" : "lazy";
  const imagePriority = eager ? "high" : "auto";
  const primaryCategory = workPrimaryCategory(work);
  const lineage = derivativeLabel(work);
  return `
    <article class="work-card" style="--thumb-ratio:${workThumbRatio(work)}">
      <a class="work-thumb" href="work.html?id=${encodeURIComponent(work.id)}" target="_blank" rel="noopener" aria-label="查看 ${escapeHtml(work.title)}">
        <img src="${escapeHtml(work.image)}" alt="${escapeHtml(work.title)}" width="282" height="320" loading="${imageLoading}" fetchpriority="${imagePriority}" decoding="async">
        <span class="work-heat-badge" aria-label="作品热度">热度 ${heat}</span>
        ${lineage ? `<span class="work-lineage-badge">${escapeHtml(lineage)}</span>` : ""}
        <span class="work-scrim"></span>
        <span class="work-overlay">
          <span class="work-title">${escapeHtml(work.title)}</span>
          <span class="work-subline">${escapeHtml(primaryCategory)} · ${escapeHtml(work.author)} · 热度 ${heat}</span>
          <span class="work-tags">${(work.tags || []).slice(0, 2).map(tag => `<span>${escapeHtml(tag)}</span>`).join("")}</span>
        </span>
      </a>
      ${workEngagementActions(work, "card")}
    </article>
  `;
}

function renderWorks(target, works, { eagerCount = 0 } = {}) {
  target.innerHTML = works.length ? works.map((work, index) => workCard(work, { eager: index < eagerCount })).join("") : `<div class="notice-card">暂无匹配作品。</div>`;
}

function nextFrame() {
  return new Promise(resolve => {
    const raf = window.requestAnimationFrame || (callback => setTimeout(callback, 0));
    raf(resolve);
  });
}

function waitForImages(scope) {
  const images = Array.from(scope.querySelectorAll("img"));
  return Promise.all(images.map(image => {
    if (image.complete) return Promise.resolve();
    return new Promise(resolve => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", resolve, { once: true });
    });
  }));
}

function measureColumnBottoms(wrapper, cards) {
  if (!wrapper?.getBoundingClientRect) return null;
  const wrapperTop = wrapper.getBoundingClientRect().top;
  const columns = new Map();
  cards.forEach(card => {
    if (card.hidden) return;
    if (!card.getBoundingClientRect) return;
    const rect = card.getBoundingClientRect();
    const key = Math.round(rect.left);
    columns.set(key, Math.max(columns.get(key) || 0, rect.bottom - wrapperTop));
  });
  const bottoms = Array.from(columns.values());
  if (!bottoms.length) return null;
  return {
    columnCount: bottoms.length,
    min: Math.min(...bottoms),
    max: Math.max(...bottoms)
  };
}

async function alignHomeFeatured(target, token) {
  const wrapper = document.getElementById("featured-window");
  if (!wrapper || !target || target.dataset.alignToken !== token) return;
  const cards = Array.from(target.querySelectorAll(".work-card"));
  wrapper.style.height = "";
  wrapper.classList.remove("is-clipped");
  cards.forEach(card => { card.hidden = false; });
  if (cards.length <= 12) return;

  await nextFrame();
  if (target.dataset.alignToken !== token) return;

  const minCount = 12;
  const maxCount = Math.min(15, cards.length);
  let best = null;
  for (let count = minCount; count <= maxCount; count += 1) {
    cards.forEach((card, index) => { card.hidden = index >= count; });
    await nextFrame();
    const measured = measureColumnBottoms(wrapper, cards.slice(0, count));
    if (!measured) continue;
    const spread = measured.max - measured.min;
    if (
      !best ||
      measured.min > best.min + 18 ||
      (Math.abs(measured.min - best.min) <= 18 && spread < best.spread)
    ) {
      best = { count, spread, ...measured };
    }
  }

  cards.forEach((card, index) => { card.hidden = !best || index >= best.count; });
  if (!best) return;
  wrapper.style.height = `${Math.max(0, Math.round(best.min))}px`;
  wrapper.classList.toggle("is-clipped", best.max > best.min + 14);
}

function listItems(items) {
  return items.map(item => `<li>${escapeHtml(item)}</li>`).join("");
}

function workHighlights(work) {
  if (Array.isArray(work.highlights) && work.highlights.length) {
    return work.highlights.filter(Boolean);
  }
  const tags = work.tags || [];
  return [
    `围绕“${tags[0] || workPrimaryCategory(work)}”组织核心界面，适合直接复刻为同类小程序。`,
    `作品已经包含封面、分类、作者、点数和 HTML 预览，可进入试用或做同款流程。`,
    `结构轻量，后续可以替换为真实数据表、接口返回或用户上传内容。`
  ];
}

function workUseCases(work) {
  if (Array.isArray(work.useCases) && work.useCases.length) {
    return work.useCases.filter(Boolean);
  }
  const map = {
    "效率工具": ["个人工作流整理", "小团队任务管理", "轻量业务表单"],
    "设计工具": ["品牌视觉提案", "素材与色板管理", "作品集展示"],
    "创意组件": ["活动专题页", "视觉橱窗", "可复用页面模块"],
    "数据可视化": ["运营数据看板", "城市或业务态势展示", "趋势与节点监控"],
    "电商营销": ["服务预约转化", "套餐展示", "营销活动落地页"],
    "教育工具": ["学习记录", "课程共创", "自然观察或知识卡片"],
    "运营后台": ["发布管理", "流程审批", "团队协作面板"],
    "AI 实验": ["提示词实验", "AI 生成结果管理", "灵感采集"]
  };
  return map[workPrimaryCategory(work)] || ["作品展示", "模板复刻", "社区发布"];
}

function relatedWorks(work) {
  const tags = new Set(work.tags || []);
  const categories = new Set(workCategories(work));
  return app.tables.works
    .filter(item => item.id !== work.id && isWorkPublished(item))
    .map(item => {
      const tagScore = (item.tags || []).filter(tag => tags.has(tag)).length;
      const categoryScore = workCategories(item).some(category => categories.has(category)) ? 3 : 0;
      return { item, score: tagScore + categoryScore, heat: workPopularity(item) };
    })
    .filter(row => row.score > 0)
    .sort((a, b) =>
      b.heat - a.heat ||
      b.score - a.score ||
      String(b.item.createdAt || "").localeCompare(String(a.item.createdAt || ""))
    )
    .slice(0, 6)
    .map(row => row.item);
}

function derivedWorks(work) {
  return app.tables.works
    .filter(item => {
      if (item.id === work.id || !isWorkPublished(item)) return false;
      return item.parentWorkId === work.id || item.originalWorkId === work.id || (!item.parentWorkId && item.originWorkId === work.id);
    })
    .sort((a, b) =>
      Number(a.derivativeGeneration || 0) - Number(b.derivativeGeneration || 0) ||
      workPopularity(b) - workPopularity(a) ||
      String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
    );
}

function workById(id) {
  return app.tables.works.find(item => item.id === id);
}

function lineageSourceCard(role, id, title, fallbackImage) {
  const source = workById(id) || {};
  const image = source.image || fallbackImage || "images/works/tiny-crm.png";
  const displayTitle = source.title || title || "来源作品";
  const href = id ? `work.html?id=${encodeURIComponent(id)}` : "#";
  return `
    <a class="source-work-card-link" href="${href}" aria-label="${escapeHtml(role)}：${escapeHtml(displayTitle)}">
      <span class="source-work-thumb"><img src="${escapeHtml(image)}" alt="${escapeHtml(displayTitle)}封面" loading="lazy" decoding="async"></span>
      <span class="source-work-copy">
        <em>${escapeHtml(role)}</em>
        <strong class="source-work-title">${escapeHtml(displayTitle)}</strong>
      </span>
    </a>
  `;
}

function originSourceMarkup(work) {
  const generation = Number(work.derivativeGeneration || 0);
  if (!generation) return "";
  const originalId = work.originalWorkId || work.originWorkId || "";
  const originalTitle = work.originalWorkTitle || work.originWorkTitle || "原作品";
  const parentId = work.parentWorkId || work.originWorkId || originalId;
  const parentTitle = work.parentWorkTitle || work.originWorkTitle || originalTitle;
  return `
    <div class="work-source-card work-lineage-card">
      <div class="work-source-head">
        <span>代码溯源</span>
        <strong>${escapeHtml(derivativeLabel(work))}</strong>
      </div>
      <div class="work-source-links" aria-label="来源作品链路">
        ${lineageSourceCard("初代作品", originalId, originalTitle, work.image)}
        ${lineageSourceCard("父代作品", parentId, parentTitle, work.image)}
      </div>
    </div>
  `;
}

function compactWorkCard(work) {
  const heat = workPopularity(work);
  const lineage = derivativeLabel(work);
  return `
    <article class="work-related-card">
      <a class="work-related-link" href="work.html?id=${encodeURIComponent(work.id)}" target="_blank" rel="noopener">
        <img src="${escapeHtml(work.image)}" alt="${escapeHtml(work.title)}" loading="lazy" decoding="async">
        <span>
          <strong>${escapeHtml(work.title)}</strong>
          <em>${lineage ? `${escapeHtml(lineage)} · ` : ""}${escapeHtml(workPrimaryCategory(work))} · ${escapeHtml(work.author)} · 热度 ${heat} · ♡ ${Number(work.likeCount || 0)} · ☆ ${Number(work.favoriteCount || 0)}</em>
        </span>
      </a>
    </article>
  `;
}

async function loginOrRegister(data) {
  if (app.serverReady) {
    try {
      if (data.mode === "register" && data.password !== data.passwordConfirm) {
        app.toast("两次输入的密码不一致。");
        return null;
      }
      const payload = data.mode === "login" ? await serverApi.login(data) : await serverApi.register(data);
      const user = applyAuthPayload(payload);
      app.toast(data.mode === "login" ? `${user.name}，欢迎回来` : `${user.name}，欢迎加入 XArt Coding社区`);
      return user;
    } catch (error) {
      app.toast(error.message || "服务器登录失败");
      return null;
    }
  }

  if (data.mode === "login") {
    const identifier = String(data.identifier || "").trim().toLowerCase();
    if (!identifier || !data.password) {
      app.toast("请填写账号和密码。");
      return null;
    }
    const user = app.tables.users.find(item =>
      String(item.email || "").toLowerCase() === identifier ||
      String(item.username || "").toLowerCase() === identifier ||
      String(item.phone || "").toLowerCase() === identifier
    );
    if (!user || user.password !== data.password) {
      app.toast("账号或密码不正确，可切换到注册。");
      return null;
    }
    user.lastLoginAt = new Date().toLocaleString("zh-CN", { hour12: false });
    user.lastActiveAt = user.lastLoginAt;
    user.activityScore = Math.min(100, Number(user.activityScore || 30) + 3);
    app.save();
    app.setCurrentUser(user.id);
    app.toast(`${user.name}，欢迎回来`);
    return user;
  }

  const user = buildUserFromRegistration(data);
  if (!user.phone) {
    app.toast("请填写手机号，手机号将作为用户唯一 ID。");
    return null;
  }
  if (!user.name || !user.password) {
    app.toast("请补齐昵称和密码。");
    return null;
  }
  if (user.password !== data.passwordConfirm) {
    app.toast("两次输入的密码不一致。");
    return null;
  }
  const duplicated = app.tables.users.some(item =>
    String(item.phone || "") === user.phone ||
    String(item.username || "") === user.phone ||
    (user.email && String(item.email || "").toLowerCase() === user.email)
  );
  if (duplicated) {
    app.toast("手机号或邮箱已被注册。");
    return null;
  }
  app.tables.users.push(user);
  app.save();
  app.setCurrentUser(user.id);
  app.toast(`${user.name}，欢迎加入 XArt Coding社区`);
  return user;
}

async function loginWithProvider(providerId) {
  const provider = authProviders.find(item => item.id === providerId);
  if (!provider) return null;
  if (app.serverReady) {
    try {
      const user = applyAuthPayload(await serverApi.providerLogin(provider));
      app.toast(`已使用 ${provider.label} 登录`);
      return user;
    } catch (error) {
      app.toast(error.message || "第三方登录失败");
      return null;
    }
  }

  const email = `${provider.id}.user@oauth.local`;
  let user = app.tables.users.find(item => item.loginProvider === provider.id && item.email === email);
  if (!user) {
    user = {
      id: makeId("u"),
      username: uniqueHandle(`${provider.id}_creator`),
      name: `${provider.label} 用户`,
      avatar: provider.id === "github" ? "images/avatars/avatar-deer.png" : "images/avatars/avatar-dog.png",
      email,
      phone: "",
      password: "oauth",
      role: "creator",
      accountType: "个人创作者",
      title: "",
      organization: "",
      field: "创意组件",
      location: "",
      website: "",
      github: provider.id === "github" ? "github-user" : "",
      weibo: provider.id === "weibo" ? "weibo_user" : "",
      bio: "",
      signature: "通过第三方账号快速加入 XArt Coding社区。",
      skills: [],
      interests: [],
      language: "zh-CN",
      timezone: "Asia/Shanghai",
      visibility: "public",
      newsletter: true,
      termsAccepted: true,
      loginProvider: provider.id,
      lastLoginAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      lastActiveAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      activityScore: 42,
      subscriptionPlan: "Free",
      subscriptionStatus: "free",
      subscriptionRenewAt: "",
      points: 100,
      joinedAt: new Date().toISOString().slice(0, 10)
    };
    app.tables.users.push(user);
    app.save();
  }
  user.lastLoginAt = new Date().toLocaleString("zh-CN", { hour12: false });
  user.lastActiveAt = user.lastLoginAt;
  user.activityScore = Math.min(100, Number(user.activityScore || 30) + 3);
  app.save();
  app.setCurrentUser(user.id);
  app.toast(`已使用 ${provider.label} 登录`);
  return user;
}

function authModalMarkup() {
  return `
    <div class="auth-modal hidden" id="auth-modal" aria-hidden="true">
      <div class="auth-backdrop" data-close-auth></div>
      <section class="auth-dialog" role="dialog" aria-modal="true" aria-label="登录注册">
        <button class="modal-close" type="button" data-close-auth>关闭</button>
        <div class="auth-copy">
          <p class="kicker">Account</p>
          <h2>进入 XArt Coding社区</h2>
          <p>登录后可以管理作品、充值点数，并保存 vibe coding 改版。</p>
        </div>
        <div class="auth-tabs">
          <button class="active" type="button" data-auth-mode="login">登录</button>
          <button type="button" data-auth-mode="register">注册</button>
        </div>
        <form id="site-auth-form" class="auth-form">
          <div class="auth-view" data-auth-view="login">
            <label class="field-group full">
              <span>手机号 / 邮箱</span>
              <input class="field" name="identifier" placeholder="请输入手机号或邮箱">
            </label>
            <label class="field-group full">
              <span>密码</span>
              <input class="field" name="password" type="password" placeholder="请输入密码">
            </label>
            <div class="login-options">
              <label class="check-line"><input type="checkbox" name="remember" checked> 记住登录状态</label>
              <button type="button" class="text-button" id="forgot-password">忘记密码</button>
            </div>
          </div>
          <div class="auth-view hidden" data-auth-view="register">
            <label class="field-group full">
              <span>手机号</span>
              <input class="field" name="phone" type="tel" placeholder="作为用户唯一 ID">
            </label>
            <label class="field-group full">
              <span>昵称</span>
              <input class="field" name="name" placeholder="请输入用户昵称">
            </label>
            <p class="subtle-section-title full">头像</p>
            ${avatarPicker("avatar", avatarOptions[0].src, { allowUpload: true })}
            <label class="field-group full">
              <span>邮箱（可选）</span>
              <input class="field" name="email" type="email" placeholder="用于找回账号和接收通知">
            </label>
            <label class="field-group full">
              <span>密码</span>
              <input class="field" name="password" type="password" placeholder="请输入密码">
            </label>
            <label class="field-group full">
              <span>再次密码</span>
              <input class="field" name="passwordConfirm" type="password" placeholder="请再次输入密码">
            </label>
          </div>
          <button class="nav-button solid full" type="submit" id="auth-submit">登录</button>
        </form>
        <div class="auth-divider"><span>第三方账号登录</span></div>
        <div class="social-login-grid" aria-label="第三方登录">
          ${authProviders.map(provider => `
            <button class="social-login" type="button" data-auth-provider="${escapeHtml(provider.id)}" title="${escapeHtml(provider.label)}登录">
              <img src="${escapeHtml(provider.icon)}" alt="${escapeHtml(provider.label)}" loading="lazy" decoding="async">
              <span>${escapeHtml(provider.label)}</span>
            </button>
          `).join("")}
        </div>
        <p class="tiny-note">服务器模式会把账号写入 users 数据表；直接打开 HTML 时会使用浏览器本地数据兜底。</p>
      </section>
    </div>
  `;
}

function ensureAuthModal() {
  let modal = document.getElementById("auth-modal");
  if (!modal || !document.getElementById("site-auth-form")) {
    modal?.remove();
    document.body.insertAdjacentHTML("beforeend", authModalMarkup());
    modal = document.getElementById("auth-modal");
  }
  if (modal.dataset.wired === "true") return modal;

  let mode = "login";
  const form = document.getElementById("site-auth-form");
  const submit = document.getElementById("auth-submit");
  const setMode = nextMode => {
    mode = nextMode;
    modal.querySelectorAll("[data-auth-mode]").forEach(button => button.classList.toggle("active", button.dataset.authMode === mode));
    modal.querySelectorAll("[data-auth-view]").forEach(view => {
      const active = view.dataset.authView === mode;
      view.classList.toggle("hidden", !active);
      view.querySelectorAll("input, select, textarea").forEach(field => field.disabled = !active);
    });
    submit.textContent = mode === "login" ? "登录" : "创建账号";
    const first = mode === "login" ? form.elements.identifier : form.elements.phone;
    setTimeout(() => first?.focus(), 0);
  };

  modal.querySelectorAll("[data-auth-mode]").forEach(button => button.addEventListener("click", () => setMode(button.dataset.authMode)));
  modal.querySelectorAll("[data-close-auth]").forEach(item => item.addEventListener("click", closeAuthModal));
  modal.querySelectorAll("[data-auth-provider]").forEach(button => {
    button.addEventListener("click", async () => {
      const user = await loginWithProvider(button.dataset.authProvider);
      if (user) completeAuthFlow(modal);
    });
  });
  document.getElementById("forgot-password")?.addEventListener("click", () => {
    app.toast("后续可在 FastAPI 中接入短信或邮件重置密码流程。");
  });
  wireAvatarPicker(modal);
  wireAvatarUpload(modal);
  form.addEventListener("change", event => {
    const option = event.target.closest(".avatar-option");
    if (!option) return;
    form.querySelectorAll(".avatar-option").forEach(item => item.classList.toggle("selected", item === option));
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());
    const user = await loginOrRegister({ ...data, mode });
    if (user) completeAuthFlow(modal, mode === "register" ? "index.html" : undefined);
  });
  modal.dataset.wired = "true";
  modal.setMode = setMode;
  return modal;
}

function openAuthModal({ mode = "login", afterLogin = "mine.html" } = {}) {
  const modal = ensureAuthModal();
  modal.dataset.afterLogin = afterLogin;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  modal.setMode?.(mode);
}

function closeAuthModal() {
  const modal = document.getElementById("auth-modal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

function currentPageTarget() {
  const page = location.pathname.split("/").pop() || "index.html";
  return `${page}${location.search}${location.hash}`;
}

function applySiteChrome() {
  const siteName = app.site().siteName || "XArt Coding社区";
  document.querySelectorAll(".brand-name").forEach(node => {
    node.textContent = siteName;
  });
  if (document.title) {
    document.title = document.title.replace(/^(?:XArt\s+)?Coding\s*\u793e\u533a|^Coding\u793e\u533a/, siteName);
  }
}

function completeAuthFlow(modal, forcedTarget) {
  setAuthNavState();
  closeAuthModal();
  const target = forcedTarget ?? modal.dataset.afterLogin;
  if (target) setTimeout(() => location.href = target, 400);
}

function renderAuthButton(button, loggedIn, user) {
  button.classList.toggle("user-nav-button", loggedIn);
  if (!loggedIn) {
    button.textContent = "登录/注册";
    button.setAttribute("aria-label", "登录或注册");
    return;
  }
  const avatar = user?.avatar || avatarOptions[0].src;
  const name = user?.name || "我的空间";
  button.innerHTML = `
    <span class="nav-user-avatar"><img src="${escapeHtml(avatar)}" alt=""></span>
    <span class="nav-user-name">${escapeHtml(name)}</span>
  `;
  button.setAttribute("aria-label", `进入${name}`);
}

function setAuthNavState() {
  const loggedIn = app.isLoggedIn();
  const user = loggedIn ? app.currentUser() : null;
  document.querySelectorAll("#open-auth, [data-open-auth]").forEach(button => {
    renderAuthButton(button, loggedIn, user);
  });
  document.querySelectorAll("[data-auth-required]").forEach(link => {
    link.setAttribute("aria-haspopup", loggedIn ? "false" : "dialog");
  });
  document.body.classList.remove("auth-state-pending");
}

function wireGlobalAuth() {
  ensureAuthModal();
  setAuthNavState();
  document.addEventListener("click", event => {
    const link = event.target.closest?.("[data-auth-required]");
    if (!link) return;
    if (app.isLoggedIn()) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const afterLogin = link.dataset.authAfterLogin ?? link.getAttribute("href") ?? "mine.html";
    openAuthModal({ mode: "login", afterLogin });
  }, true);
  document.querySelectorAll("#open-auth, [data-open-auth]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      if (app.isLoggedIn()) {
        location.href = "mine.html";
      } else {
        openAuthModal({ mode: "login", afterLogin: currentPageTarget() });
      }
    });
  });
  document.querySelectorAll('a[href="mine.html"]:not([data-auth-required]), a[href$="/mine.html"]:not([data-auth-required])').forEach(link => {
    link.addEventListener("click", event => {
      if (app.isLoggedIn()) return;
      event.preventDefault();
      openAuthModal({ mode: "login", afterLogin: "mine.html" });
    });
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeAuthModal();
  });
}

function initHome() {
  const site = app.site();
  const announcement = document.getElementById("site-announcement");
  const tagline = document.getElementById("site-tagline");
  if (announcement) announcement.textContent = site.announcement;
  if (tagline) tagline.textContent = site.tagline;
  const featuredTarget = document.getElementById("featured-works");
  const featuredWorks = app.tables.works
    .filter(work => work.featured && isWorkPublished(work))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const homeSearch = document.getElementById("home-search-input");
  const homeSearchForm = document.getElementById("home-search-form");
  let featuredAlignToken = 0;

  function applyHomeSearch() {
    const term = homeSearch ? homeSearch.value.trim().toLowerCase() : "";
    const visibleWorks = featuredWorks.filter(work => workMatches(work, term)).slice(0, 15);
    renderWorks(featuredTarget, visibleWorks, { eagerCount: 9 });
    featuredAlignToken += 1;
    const token = String(featuredAlignToken);
    featuredTarget.dataset.alignToken = token;
    alignHomeFeatured(featuredTarget, token);
  }

  applyHomeSearch();
  if (homeSearch) homeSearch.addEventListener("input", applyHomeSearch);
  if (homeSearchForm) {
    homeSearchForm.addEventListener("submit", event => {
      event.preventDefault();
      applyHomeSearch();
      featuredTarget.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  window.addEventListener("resize", () => {
    featuredAlignToken += 1;
    const token = String(featuredAlignToken);
    featuredTarget.dataset.alignToken = token;
    alignHomeFeatured(featuredTarget, token);
  });

  const publishedWorks = app.tables.works.filter(isWorkPublished);
  const categoryCount = appCategories().length;
  const authorCount = new Set(publishedWorks.map(work => work.author).filter(Boolean)).size;
  const workCount = document.getElementById("home-work-count");
  const categoryCountNode = document.getElementById("home-category-count");
  const authorCountNode = document.getElementById("home-author-count");
  if (workCount) workCount.textContent = publishedWorks.length;
  if (categoryCountNode) categoryCountNode.textContent = categoryCount;
  if (authorCountNode) authorCountNode.textContent = authorCount;

  document.getElementById("home-ads").innerHTML = app.tables.ads.map(ad => `
    <article class="home-feed-item">
      <span>Update</span>
      <div>
        <h3>${escapeHtml(ad.title)}</h3>
        <p>${escapeHtml(ad.text)}</p>
      </div>
      <a class="text-link" href="upload.html" target="_blank" rel="noopener" data-auth-required>${escapeHtml(ad.cta)}</a>
    </article>
  `).join("");
}

function initCommunity() {
  const target = document.getElementById("community-works");
  const search = document.getElementById("search-input");
  const searchForm = document.getElementById("community-search-form");
  const categoryTabs = document.getElementById("category-filter");
  let activeCategory = "";

  function renderCategoryTabs() {
    categoryTabs.innerHTML = categoryOptions().map(category => `
      <button type="button" class="${category === activeCategory ? "active" : ""}" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>
    `).join("");
  }

  function applyFilters() {
    const term = search.value.trim().toLowerCase();
    const works = app.tables.works.filter(work => workMatches(work, term, activeCategory));
    renderWorks(target, works, { eagerCount: 9 });
  }

  if (location.hash === "#upload") location.replace("upload.html");
  search.addEventListener("input", applyFilters);
  searchForm.addEventListener("submit", event => {
    event.preventDefault();
    applyFilters();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  categoryTabs.addEventListener("click", event => {
    const button = event.target.closest("[data-category]");
    if (!button) return;
    activeCategory = activeCategory === button.dataset.category ? "" : button.dataset.category;
    renderCategoryTabs();
    applyFilters();
  });

  renderCategoryTabs();
  applyFilters();
}

function initUpload() {
  const form = document.getElementById("upload-page-form");
  const summary = document.getElementById("upload-summary");
  const coverPreview = document.getElementById("upload-cover-preview");
  const categoryList = document.getElementById("upload-categories");
  const reviewState = document.getElementById("upload-review-state");
  const reviewMessage = document.getElementById("upload-review-message");
  const uploadWorkspace = document.querySelector(".upload-workspace");
  const user = app.currentUser();

  categoryList.innerHTML = renderUploadCategoryButtons([appCategories()[0]]);
  if (app.isLoggedIn() && form.elements.author) form.elements.author.value = user.name || "";

  const statusLabel = value => ({
    published: "立即发布",
    reviewing: "审核中",
    draft: "保存草稿",
    review: "提交审核"
  })[value] || value || "审核中";

  function renderSummary() {
    const data = new FormData(form);
    const tags = splitTags(data.get("tags")).join(" / ") || "待填写";
    const selectedCategories = selectedCategoriesFrom(form).join(" / ") || "待填写";
    const paidTrial = data.get("paidTrial") === "true";
    summary.innerHTML = `
      <dt>作品名称</dt><dd>${escapeHtml(data.get("title") || "待填写")}</dd>
      <dt>分类</dt><dd>${escapeHtml(selectedCategories)}</dd>
      <dt>作者</dt><dd>${escapeHtml(data.get("author") || user.name || "当前用户")}</dd>
      <dt>做同款方式</dt><dd>${paidTrial ? "有偿做同款" : "免费做同款"}</dd>
      <dt>状态</dt><dd>${escapeHtml(statusLabel(data.get("status")))}</dd>
      <dt>标签</dt><dd>${escapeHtml(tags)}</dd>
    `;
  }

  async function renderCoverPreview() {
    const file = form.elements.cover?.files?.[0];
    if (!file) {
      coverPreview.innerHTML = "<span>封面预览</span>";
      return;
    }
    const dataUrl = await fileToDataUrl(file);
    coverPreview.innerHTML = `<img src="${escapeHtml(dataUrl)}" alt="封面预览">`;
  }

  form.addEventListener("input", renderSummary);
  wireCategoryButtonPicker(categoryList, renderSummary);
  form.elements.cover?.addEventListener("change", renderCoverPreview);
  form.addEventListener("reset", () => {
    setTimeout(() => {
      categoryList.innerHTML = renderUploadCategoryButtons([appCategories()[0]]);
      reviewState?.classList.add("hidden");
      uploadWorkspace?.classList.remove("hidden");
      renderSummary();
      renderCoverPreview();
    }, 0);
  });

  document.getElementById("upload-another-work")?.addEventListener("click", () => {
    form.reset();
    categoryList.innerHTML = renderUploadCategoryButtons([appCategories()[0]]);
    reviewState?.classList.add("hidden");
    uploadWorkspace?.classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  async function handleAiCopyGenerate(event) {
    const button = event.currentTarget;
    const target = button.dataset.aiCopyTarget;
    const targetField = form.elements[target];
    if (!target || !targetField) return;
    if (!app.isLoggedIn()) {
      openAuthModal({ mode: "login", afterLogin: currentPageTarget() });
      return;
    }
    const data = new FormData(form);
    const description = String(data.get("description") || "").trim();
    const tags = String(data.get("tags") || "").trim();
    if (!description) {
      app.toast("请先填写一句话简介", "error");
      form.elements.description?.focus();
      return;
    }
    if (!splitTags(tags).length) {
      app.toast("请先填写标签", "error");
      form.elements.tags?.focus();
      return;
    }
    const backendReady = await app.ensureBackendReady();
    if (!backendReady) {
      app.toast("AI 生成需要连接 FastAPI 服务", "error");
      return;
    }
    if (!serverApi.token) {
      app.toast("请重新登录后使用 AI 生成", "error");
      openAuthModal({ mode: "login", afterLogin: currentPageTarget() });
      return;
    }
    const originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span aria-hidden="true">✦</span><span>生成中</span>`;
    try {
      const payload = await serverApi.generateUploadCopy({
        target,
        title: String(data.get("title") || ""),
        categories: selectedCategoriesFrom(form),
        description,
        tags
      });
      targetField.value = payload.text || "";
      targetField.dispatchEvent(new Event("input", { bubbles: true }));
      renderSummary();
      app.toast(`${uploadCopyTargetLabels[target] || "文案"}已生成`, "success");
    } catch (error) {
      app.toast(error.message || "AI 生成失败", "error");
    } finally {
      button.disabled = false;
      button.innerHTML = originalHtml || `<span aria-hidden="true">✦</span><span>AI生成</span>`;
    }
  }

  form.querySelectorAll("[data-ai-copy-target]").forEach(button => {
    button.addEventListener("click", handleAiCopyGenerate);
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!app.isLoggedIn()) {
      openAuthModal({ mode: "login", afterLogin: currentPageTarget() });
      return;
    }
    const data = new FormData(form);
    if (!validateWorkSubmissionForm(form, { requireProgramFile: true })) return;
    appendSelectedCategories(data, form);
    const backendReady = await app.ensureBackendReady();
    if (!backendReady) {
      app.toast("保存失败：无法写入本机 data/community.db 和 uploads。请先启动 8010 本地 FastAPI 服务。", "error");
      return;
    }
    if (!serverApi.token) {
      app.toast("请重新登录后上传，作品会保存到本机 FastAPI 数据库。", "error");
      openAuthModal({ mode: "login", afterLogin: currentPageTarget() });
      return;
    }

    try {
      const payload = await serverApi.createWork(data);
      const work = payload.work;
      upsertById(app.tables.works, work);
      db.save(app.tables);
      if (reviewMessage) {
        reviewMessage.textContent = `《${work.title}》已上传到服务器，当前状态为审核中。管理员审核通过后，作品才会出现在首页和社区作品库。`;
      }
      reviewState?.classList.remove("hidden");
      uploadWorkspace?.classList.add("hidden");
      app.toast("上传成功：作品已保存到 FastAPI 后台，当前状态为审核中。", "success");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      app.toast(`上传失败：${error.message || "服务器没有保存作品"}`, "error");
    }
  });

  renderSummary();
}

async function initWork() {
  const work = app.findWork(app.qs("id"));
  recordWorkMetric(work.id, "view");
  const heat = workPopularity(work);
  const lineage = derivativeLabel(work);
  const paidWork = isPaidWork(work);
  const access = workAccessState(work);
  document.title = `${work.title} - XArt Coding社区`;
  document.getElementById("work-title").textContent = work.title;
  document.getElementById("work-image").src = work.image;
  document.getElementById("work-image").alt = work.title;
  const topVibeLink = document.getElementById("vibe-link");
  if (topVibeLink) topVibeLink.href = `vibe.html?id=${encodeURIComponent(work.id)}`;
  const sideVibeLink = document.getElementById("vibe-link-side");
  sideVibeLink.href = `vibe.html?id=${encodeURIComponent(work.id)}`;
  sideVibeLink.textContent = "做同款";
  sideVibeLink.addEventListener("click", event => {
    if (!paidWork || !app.isLoggedIn()) return;
    event.preventDefault();
    app.toast("该作品为会员作品，做同款功能需会员权限。会员系统之后开放。", "error");
  });
  document.getElementById("work-info").innerHTML = `
    ${lineage ? `<p class="work-lineage-note">${escapeHtml(lineage)}</p>` : ""}
    <p class="work-description">${escapeHtml(work.description)}</p>
    <dl class="work-meta-list">
      <div><dt>作者</dt><dd>${escapeHtml(work.author)}</dd></div>
      <div><dt>发布时间</dt><dd>${escapeHtml(work.createdAt)}</dd></div>
      <div><dt>热度</dt><dd><span class="work-heat-pill">${heat}</span></dd></div>
    </dl>
    ${workAccessMarkup(work)}
    <div class="tag-row">${(work.tags || []).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
    ${originSourceMarkup(work)}
  `;
  const similar = relatedWorks(work);
  const derived = derivedWorks(work);
  const creatorNote = work.creatorNote || `${work.author} 将这个作品整理为可试用、可复刻的 HTML 小程序。你可以先试用原始版本，再进入做同款页面保留结构并改写成自己的版本。`;
  document.getElementById("work-extra").innerHTML = `
    <section class="work-extra-section work-overview-section">
      <div>
        <p class="kicker">Overview</p>
        <h2>作品概览</h2>
        <p>${escapeHtml(work.description)}</p>
      </div>
      <dl class="work-fact-list">
        <div><dt>作品分类</dt><dd>${escapeHtml(workCategories(work).join(" / "))}</dd></div>
        <div><dt>当前状态</dt><dd>${escapeHtml(workStatusLabel(work.status))}</dd></div>
        <div><dt>热度</dt><dd><span class="work-heat-pill">${heat}</span></dd></div>
        <div><dt>开放状态</dt><dd>${escapeHtml(access.title)}</dd></div>
      </dl>
    </section>

    <section class="work-extra-grid">
      <article class="work-info-block">
        <h2>功能亮点</h2>
        <ul>${listItems(workHighlights(work))}</ul>
      </article>
      <article class="work-info-block">
        <h2>适用场景</h2>
        <ul>${listItems(workUseCases(work))}</ul>
      </article>
    </section>

    <section class="work-extra-section">
      <div>
        <p class="kicker">Creator Note</p>
        <h2>作者说明</h2>
        <p>${escapeHtml(creatorNote)}</p>
      </div>
    </section>

    <section class="work-extra-grid">
      <article class="work-info-block">
        <h2>复刻动态</h2>
        <ol class="work-timeline">
          <li><span>已发布</span><strong>${escapeHtml(work.createdAt)}</strong></li>
          <li><span>可试用</span><strong>独立 HTML 预览</strong></li>
          <li><span>可复刻</span><strong>进入 vibe coding</strong></li>
        </ol>
      </article>
      <article class="work-info-block">
        <h2>内容标签</h2>
        <div class="tag-row">${(work.tags || []).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
      </article>
    </section>

    ${derived.length ? `
      <section class="work-extra-section work-derivative-section">
        <div class="work-section-head">
          <div>
            <p class="kicker">Derivatives</p>
            <h2>衍生作品</h2>
          </div>
          <span class="work-derivative-count">${derived.length} 个改版</span>
        </div>
        <div class="work-related-grid">
          ${derived.length ? derived.map(compactWorkCard).join("") : ""}
        </div>
      </section>
    ` : ""}

    <section class="work-extra-section">
      <div class="work-section-head">
        <div>
          <p class="kicker">Related</p>
          <h2>相似作品推荐</h2>
        </div>
        <a class="text-link" href="community.html">查看社区</a>
      </div>
      <div class="work-related-grid">
        ${similar.length ? similar.map(compactWorkCard).join("") : `<p class="empty-note">暂时没有找到相似作品。</p>`}
      </div>
    </section>
  `;
  const trialModal = document.getElementById("trial-modal");
  const trialFrame = document.getElementById("trial-frame");
  const trialTitle = document.getElementById("trial-title");
  const trialMeta = document.getElementById("trial-meta");
  const trialFullscreenToggle = document.getElementById("trial-fullscreen-toggle");
  const setTrialFullscreen = isFullscreen => {
    trialModal.classList.toggle("is-fullscreen", isFullscreen);
    trialFullscreenToggle.textContent = isFullscreen ? "缩小" : "全屏";
    trialFullscreenToggle.setAttribute("aria-pressed", String(isFullscreen));
  };
  const closeTrial = () => {
    setTrialFullscreen(false);
    trialModal.classList.add("hidden");
    trialModal.classList.remove("is-loading");
    trialModal.setAttribute("aria-hidden", "true");
    trialFrame.src = "about:blank";
    trialFrame.removeAttribute("srcdoc");
  };
  trialTitle.textContent = "\u8bd5\u7528\u7a0b\u5e8f\uff1a" + work.title;
  trialMeta.textContent = `${workPrimaryCategory(work)} · ${work.author || "未知作者"} · ${access.copy}`;
  grantPreviewFramePermissions(trialFrame);
  trialFullscreenToggle.addEventListener("click", () => {
    setTrialFullscreen(!trialModal.classList.contains("is-fullscreen"));
  });
  document.getElementById("try-work").addEventListener("click", () => {
    recordWorkMetric(work.id, "trial");
    trialModal.classList.add("is-loading");
    trialModal.classList.remove("hidden");
    trialModal.setAttribute("aria-hidden", "false");
    trialFrame.addEventListener("load", () => {
      trialModal.classList.remove("is-loading");
    }, { once: true });
    if (app.serverReady) {
      trialFrame.removeAttribute("srcdoc");
      grantPreviewFramePermissions(trialFrame);
      trialFrame.src = workPreviewUrl(work.id);
    } else {
      trialFrame.removeAttribute("src");
      loadStaticPreviewFallback(trialFrame, work.html);
    }
  });
  trialModal.querySelectorAll("[data-close-trial]").forEach(item => item.addEventListener("click", closeTrial));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeTrial();
  });
}

async function initVibe() {
  const workId = app.qs("id");
  const chat = document.getElementById("vibe-chat");
  const preview = document.getElementById("vibe-preview");
  const prompt = document.getElementById("vibe-prompt");
  const form = document.getElementById("vibe-form");
  const status = document.getElementById("vibe-status");
  const saveButton = document.getElementById("save-variant");
  const refreshButton = document.getElementById("refresh-preview");
  let activeSession = null;
  grantPreviewFramePermissions(preview);

  const setStatus = text => {
    status.textContent = text;
  };
  const renderMessages = messages => {
    chat.innerHTML = messages.map(message => `
      <article class="vibe-message ${message.role === "user" ? "is-user" : "is-assistant"}">
        <span>${message.role === "user" ? "你" : "模型"}</span>
        ${message.progress ? `
          <div class="vibe-progress" aria-label="coding 进度">
            <p>${escapeHtml(message.content || "")}</p>
            <ol>
              ${modelThinkingSteps.map(step => `<li>${escapeHtml(step)}</li>`).join("")}
            </ol>
          </div>
        ` : `<p>${escapeHtml(message.content || "")}</p>`}
      </article>
    `).join("");
    chat.scrollTop = chat.scrollHeight;
  };
  const renderSession = session => {
    activeSession = session;
    document.getElementById("vibe-title").textContent = `做同款：${session.work.title}`;
    document.getElementById("vibe-chat-title").textContent = session.work.title;
    preview.src = vibePreviewUrl(session);
    renderMessages(session.messages || []);
    setStatus("已就绪");
  };
  const setBusy = busy => {
    form.classList.toggle("is-busy", busy);
    prompt.disabled = busy;
    document.getElementById("run-vibe").disabled = busy;
    saveButton.disabled = busy || !activeSession;
    refreshButton.disabled = !activeSession;
    if (busy) setStatus("模型 coding 中");
  };

  if (!app.serverReady) {
    chat.innerHTML = `<article class="vibe-message is-assistant"><span>模型</span><p>做同款需要连接后端服务后使用。</p></article>`;
    setStatus("未连接");
    preview.src = "about:blank";
    return;
  }

  setBusy(true);
  try {
    const payload = await serverApi.createVibeSession(workId);
    if (payload.session?.work) {
      upsertById(app.tables.works, payload.session.work);
      app.save();
    }
    renderSession(payload.session);
  } catch (error) {
    chat.innerHTML = `<article class="vibe-message is-assistant"><span>模型</span><p>${escapeHtml(error.message || "做同款会话创建失败")}</p></article>`;
    setStatus("不可用");
  } finally {
    setBusy(false);
  }

  refreshButton.addEventListener("click", () => {
    if (!activeSession) return;
    preview.src = vibePreviewUrl(activeSession);
  });
  prompt.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    form.requestSubmit();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const value = prompt.value.trim();
    if (!value) return app.toast("请输入修改指令");
    if (!activeSession) return app.toast("做同款会话尚未就绪");
    const optimisticMessages = [...(activeSession.messages || []), { role: "user", content: value }];
    renderMessages([...optimisticMessages, createModelProgressMessage()]);
    prompt.value = "";
    setBusy(true);
    try {
      const payload = await serverApi.sendVibeMessage(activeSession.id, value);
      renderSession(payload.session);
      app.toast("预览已更新");
    } catch (error) {
      activeSession.messages = [...optimisticMessages, { role: "assistant", content: error.message || "生成失败，请稍后再试。" }];
      renderMessages(activeSession.messages);
      setStatus("生成失败");
    } finally {
      setBusy(false);
    }
  });
  saveButton.addEventListener("click", async () => {
    if (!activeSession) return app.toast("做同款会话尚未就绪");
    const submission = await askVariantSubmission(activeSession.work);
    if (!submission) return;
    setBusy(true);
    try {
      const payload = await serverApi.saveVibeSession(activeSession.id, submission);
      app.tables.works = upsertById(app.tables.works, payload.work);
      app.save();
      app.toast("新作品已保存");
      setTimeout(() => location.href = `work.html?id=${encodeURIComponent(payload.work.id)}`, 500);
    } catch (error) {
      app.toast(error.message || "保存失败");
    } finally {
      setBusy(false);
    }
  });
}

function initMine() {
  let tab = "profile";
  const content = document.getElementById("mine-content");
  const tabs = document.querySelectorAll("[data-mine-tab]");

  if (!app.isLoggedIn()) {
    tabs.forEach(button => button.disabled = true);
    content.innerHTML = `
      <section class="login-required">
        <p class="kicker">Member</p>
        <h2>请先登录或注册</h2>
        <p>登录后可以管理账号资料、作品和点数；账号资料会通过服务器 users 表保存。</p>
        <div class="stack-actions horizontal">
          <button class="nav-button solid" type="button" data-open-auth>登录/注册</button>
          <a class="nav-button" href="community.html">先逛社区</a>
        </div>
      </section>
    `;
    content.querySelector("[data-open-auth]").addEventListener("click", () => openAuthModal({ mode: "login", afterLogin: "mine.html" }));
    openAuthModal({ mode: "login", afterLogin: "mine.html" });
    return;
  }

  function render() {
    const user = app.currentUser();
    tabs.forEach(button => button.classList.toggle("active", button.dataset.mineTab === tab));
    if (tab === "profile") {
      content.innerHTML = `
        <div class="profile-head">
          <img class="profile-avatar" src="${escapeHtml(user.avatar || avatarOptions[0].src)}" alt="${escapeHtml(user.name)}">
          <div>
            <p class="kicker">Profile</p>
            <h2>账号信息</h2>
            <p>基础账号信息写入 users 表，头像和创作者资料写入 user_profiles 表。</p>
          </div>
        </div>
        <form id="profile-form" class="form-grid profile-form">
          <p class="subtle-section-title full">基础账号</p>
          <label class="field-group">
            <span>唯一 ID</span>
            <input class="field readonly-field" name="username" value="${escapeHtml(user.username || user.phone || user.id || "")}" readonly aria-readonly="true" title="唯一 ID 由注册信息生成，不能修改">
          </label>
          <label class="field-group">
            <span>用户昵称</span>
            <input class="field" name="name" value="${escapeHtml(user.name || "")}" placeholder="请输入用户昵称">
          </label>
          <label class="field-group">
            <span>邮箱</span>
            <input class="field" name="email" type="email" value="${escapeHtml(user.email || "")}" placeholder="用于找回账号和接收通知">
          </label>
          <label class="field-group">
            <span>手机号</span>
            <input class="field" name="phone" value="${escapeHtml(user.phone || "")}" placeholder="请输入手机号">
          </label>
          <label class="field-group">
            <span>新密码</span>
            <input class="field" name="password" type="password" placeholder="不修改请留空">
          </label>
          <label class="field-group">
            <span>再次输入新密码</span>
            <input class="field" name="passwordConfirm" type="password" placeholder="再次输入新密码">
          </label>
          <p class="subtle-section-title full">头像</p>
          ${avatarPicker("avatar", user.avatar, { allowUpload: true })}
          <p class="subtle-section-title full">创作者资料</p>
          <label class="field-group">
            <span>个性签名</span>
            <input class="field" name="signature" value="${escapeHtml(user.signature || "")}" placeholder="一句话介绍自己">
          </label>
          <label class="field-group">
            <span>所属领域</span>
            <select class="field" name="field">${optionList(domainOptions, user.field || "创意组件")}</select>
          </label>
          <label class="field-group">
            <span>账号类型</span>
            <select class="field" name="accountType">${optionList(accountTypeOptions, user.accountType || "个人创作者")}</select>
          </label>
          <label class="field-group">
            <span>职业/头衔</span>
            <input class="field" name="title" value="${escapeHtml(user.title || "")}" placeholder="例如：独立开发者">
          </label>
          <label class="field-group">
            <span>公司/组织/工作室</span>
            <input class="field" name="organization" value="${escapeHtml(user.organization || "")}" placeholder="请输入组织名称">
          </label>
          <label class="field-group">
            <span>所在地</span>
            <input class="field" name="location" value="${escapeHtml(user.location || "")}" placeholder="请输入所在城市">
          </label>
          <label class="field-group full">
            <span>个人主页或作品集链接</span>
            <input class="field" name="website" type="url" value="${escapeHtml(user.website || "")}" placeholder="https://">
          </label>
          <label class="field-group full">
            <span>个人简介</span>
            <textarea class="field textarea" name="bio" placeholder="介绍你的创作方向、代表作品或合作意向">${escapeHtml(user.bio || "")}</textarea>
          </label>
          <label class="field-group">
            <span>界面语言</span>
            <select class="field" name="language">
              <option value="zh-CN" ${user.language === "zh-CN" ? "selected" : ""}>中文</option>
              <option value="en-US" ${user.language === "en-US" ? "selected" : ""}>English</option>
              <option value="ja-JP" ${user.language === "ja-JP" ? "selected" : ""}>日本語</option>
            </select>
          </label>
          <label class="field-group">
            <span>时区</span>
            <select class="field" name="timezone">
              <option value="Asia/Shanghai" ${user.timezone === "Asia/Shanghai" ? "selected" : ""}>Asia/Shanghai</option>
              <option value="UTC" ${user.timezone === "UTC" ? "selected" : ""}>UTC</option>
              <option value="America/Los_Angeles" ${user.timezone === "America/Los_Angeles" ? "selected" : ""}>America/Los_Angeles</option>
              <option value="Europe/London" ${user.timezone === "Europe/London" ? "selected" : ""}>Europe/London</option>
            </select>
          </label>
          <label class="field-group">
            <span>主页可见性</span>
            <select class="field" name="visibility">
              <option value="public" ${user.visibility === "public" ? "selected" : ""}>公开主页</option>
              <option value="community" ${user.visibility === "community" ? "selected" : ""}>仅社区可见</option>
              <option value="private" ${user.visibility === "private" ? "selected" : ""}>暂不公开</option>
            </select>
          </label>
          <label class="check-line"><input type="checkbox" name="newsletter" ${user.newsletter ? "checked" : ""}> 接收精选作品、活动和安全提醒</label>
          <label class="check-line full"><input type="checkbox" name="termsAccepted" ${user.termsAccepted ? "checked" : ""}> 我同意服务条款、隐私政策和社区准则</label>
          <div class="form-actions full">
            <button class="nav-button solid" type="submit">保存账号</button>
            <button class="nav-button" type="button" id="logout-user">退出登录</button>
          </div>
        </form>
      `;
      wireAvatarPicker(content);
      wireAvatarUpload(content);
      document.getElementById("profile-form").addEventListener("submit", async event => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.currentTarget).entries());
        if (data.password !== data.passwordConfirm) return app.toast("两次输入的密码不一致。");
        const stableUsername = user.username || user.phone || user.id || "";
        const profilePayload = {
          username: stableUsername,
          name: data.name || user.name,
          avatar: data.avatar || user.avatar,
          email: String(data.email || "").trim().toLowerCase(),
          phone: String(data.phone || "").trim(),
          password: data.password || "",
          accountType: data.accountType,
          title: data.title,
          organization: data.organization,
          field: data.field,
          location: data.location,
          website: data.website,
          bio: data.bio,
          signature: data.signature,
          language: data.language,
          timezone: data.timezone,
          visibility: data.visibility,
          newsletter: Boolean(data.newsletter),
          termsAccepted: Boolean(data.termsAccepted)
        };
        if (app.serverReady) {
          try {
            const saved = await serverApi.updateProfile(profilePayload);
            Object.assign(user, saved.user);
            upsertById(app.tables.users, saved.user);
            app.save();
            setAuthNavState();
            app.toast("账号资料已保存到 user_profiles 数据表");
            render();
          } catch (error) {
            app.toast(error.message || "账号资料保存失败");
          }
          return;
        }
        Object.assign(user, {
          ...profilePayload,
          password: data.password || user.password,
          github: user.github || "",
          weibo: user.weibo || "",
          skills: user.skills || [],
          interests: user.interests || []
        });
        app.save();
        setAuthNavState();
        app.toast("账号资料已保存");
        render();
      });
      document.getElementById("logout-user").addEventListener("click", () => {
        app.logout();
        app.toast("已退出登录");
        setTimeout(() => location.href = "index.html", 500);
      });
    }
    if (tab === "works") {
      const mine = app.tables.works.filter(work => work.authorId === user.id || work.author === user.name);
      const totalLikes = mine.reduce((sum, work) => sum + Number(work.likeCount || 0), 0);
      const totalFavorites = mine.reduce((sum, work) => sum + Number(work.favoriteCount || 0), 0);
      const totalHeat = mine.reduce((sum, work) => sum + workPopularity(work), 0);
      const metricRows = mine
        .slice()
        .sort((a, b) => workPopularity(b) - workPopularity(a))
        .map(work => `
          <a class="mine-work-metric-row" href="work.html?id=${encodeURIComponent(work.id)}" target="_blank" rel="noopener">
            <span>${escapeHtml(work.title)}</span>
            <strong>热度 ${workPopularity(work)}</strong>
            <em>♡ ${Number(work.likeCount || 0)}</em>
            <em>☆ ${Number(work.favoriteCount || 0)}</em>
          </a>
        `).join("");
      content.innerHTML = `
        <div class="mine-section-head">
          <div>
            <p class="kicker">Works</p>
            <h2>作品管理</h2>
          </div>
          <a class="nav-button solid" href="upload.html" target="_blank" rel="noopener">提交作品</a>
        </div>
        <section class="mine-engagement-summary" aria-label="我的作品互动汇总">
          <article><strong>${mine.length}</strong><span>我的作品</span></article>
          <article><strong>${totalLikes}</strong><span>收到点赞</span></article>
          <article><strong>${totalFavorites}</strong><span>收到收藏</span></article>
          <article><strong>${totalHeat}</strong><span>综合热度</span></article>
        </section>
        <section class="mine-section">
          <h3>我的作品互动</h3>
          <div class="mine-work-metrics">${metricRows || `<p class="empty-note">暂无作品互动数据。</p>`}</div>
        </section>
        <section class="mine-section">
          <h3>我的作品</h3>
          <div class="masonry-grid">${mine.map(workCard).join("") || `<p class="empty-note">暂无作品。</p>`}</div>
        </section>
      `;
    }
    if (tab === "likes") {
      const likedWorks = app.tables.works.filter(work => hasWorkEngagement(work.id, "like"));
      const favoriteWorks = app.tables.works.filter(work => hasWorkEngagement(work.id, "favorite"));
      content.innerHTML = `
        <div class="mine-section-head">
          <div>
            <p class="kicker">Saved</p>
            <h2>点赞收藏</h2>
          </div>
        </div>
        <section class="mine-engagement-summary" aria-label="点赞收藏汇总">
          <article><strong>${likedWorks.length}</strong><span>我点赞的作品</span></article>
          <article><strong>${favoriteWorks.length}</strong><span>我收藏的作品</span></article>
        </section>
        <section class="mine-section">
          <h3>我点赞的作品</h3>
          <div class="masonry-grid">${likedWorks.map(workCard).join("") || `<p class="empty-note">还没有点赞作品。</p>`}</div>
        </section>
        <section class="mine-section">
          <h3>我收藏的作品</h3>
          <div class="masonry-grid">${favoriteWorks.map(workCard).join("") || `<p class="empty-note">还没有收藏作品。</p>`}</div>
        </section>
      `;
    }
    if (tab === "billing") {
      content.innerHTML = `
        <h2>充值点数</h2>
        <p>静态演示会写入 pointsRecords 表，并更新 users 表余额。</p>
        <div class="metric-grid">
          <button class="nav-button" data-recharge="100">100 点</button>
          <button class="nav-button" data-recharge="500">500 点</button>
          <button class="nav-button" data-recharge="1200">1200 点</button>
        </div>
      `;
      content.querySelectorAll("[data-recharge]").forEach(button => {
        button.addEventListener("click", () => {
          const amount = Number(button.dataset.recharge);
          user.points += amount;
          app.tables.pointsRecords.unshift({ id: makeId("p"), userId: user.id, type: "recharge", amount, note: "用户本地充值", createdAt: new Date().toISOString().slice(0, 10) });
          app.save();
          app.toast("点数流水表已更新");
          render();
        });
      });
    }
  }

  tabs.forEach(button => button.addEventListener("click", () => {
    tab = button.dataset.mineTab;
    render();
  }));
  render();
}

function initAdmin() {
  const login = document.getElementById("admin-login");
  const consoleView = document.getElementById("admin-console");
  const content = document.getElementById("admin-content");
  const auth = app.adminAuth();
  let tab = "site";

  function showConsole() {
    login.classList.add("hidden");
    consoleView.classList.remove("hidden");
    render();
  }

  if (localStorage.getItem("codingCommunityAdminAuthed") === "true") showConsole();

  document.getElementById("admin-login-form").addEventListener("submit", event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (data.username === auth.username && data.password === auth.password) {
      localStorage.setItem("codingCommunityAdminAuthed", "true");
      showConsole();
    } else {
      app.toast("后台账号或密码错误");
    }
  });

  document.getElementById("admin-logout").addEventListener("click", () => {
    localStorage.removeItem("codingCommunityAdminAuthed");
    location.reload();
  });

  function renderTableRows(rows, columns) {
    return rows.map(row => `<tr>${columns.map(column => `<td>${escapeHtml(row[column] ?? "")}</td>`).join("")}</tr>`).join("");
  }

  function render() {
    document.querySelectorAll("[data-admin-tab]").forEach(button => button.classList.toggle("active", button.dataset.adminTab === tab));
    if (tab === "site") {
      const site = app.site();
      content.innerHTML = `
        <h2>站点内容表</h2>
        <form id="site-form" class="form-grid">
          <input class="field" name="siteName" value="${escapeHtml(site.siteName)}" placeholder="站点名称">
          <input class="field" name="announcement" value="${escapeHtml(site.announcement)}" placeholder="公告">
          <textarea class="field textarea full" name="tagline">${escapeHtml(site.tagline)}</textarea>
          <button class="nav-button solid" type="submit">保存</button>
        </form>
      `;
      document.getElementById("site-form").addEventListener("submit", event => {
        event.preventDefault();
        Object.assign(site, Object.fromEntries(new FormData(event.currentTarget).entries()));
        app.save();
        app.toast("settings 表已更新");
      });
    }
    if (tab === "ai") {
      const api = app.tables.apiConfigs[0];
      const apiKeyPlaceholder = api.apiKeyConfigured ? "已保存 API Key，留空则保持不变" : "API Key";
      content.innerHTML = `
        <h2>API 接入表</h2>
        <p>DeepSeek 配置保存在 apiConfigs 表。真实上线时应由服务器读取 key 并代理请求。</p>
        <form id="api-form" class="form-grid">
          <input class="field" name="provider" value="${escapeHtml(api.provider)}">
          <input class="field" name="model" value="${escapeHtml(api.model)}">
          <input class="field full" name="baseUrl" value="${escapeHtml(api.baseUrl)}">
          <input class="field full" name="apiKey" value="" placeholder="${escapeHtml(apiKeyPlaceholder)}" autocomplete="off">
          <p class="form-help full">${api.apiKeyConfigured ? `服务器已保存 API Key（${escapeHtml(api.apiKeySource || "database")}，${Number(api.apiKeyLength || 0)} 位）；留空不会覆盖。` : "尚未保存 API Key。"}</p>
          <input class="field" name="temperature" type="number" step="0.05" value="${Number(api.temperature)}">
          <button class="nav-button solid" type="submit">保存</button>
        </form>
      `;
      document.getElementById("api-form").addEventListener("submit", event => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.currentTarget).entries());
        if (!String(data.apiKey || "").trim() && api.apiKey) delete data.apiKey;
        Object.assign(api, data);
        app.save();
        app.toast("apiConfigs 表已更新");
      });
    }
    if (tab === "works") {
      content.innerHTML = `
        <h2>作品表</h2>
        <table class="table"><thead><tr><th>作品</th><th>分类</th><th>作者</th><th>精选</th><th>操作</th></tr></thead><tbody>
          ${app.tables.works.map(work => `
            <tr>
              <td>${escapeHtml(work.title)}</td>
              <td>${escapeHtml(workPrimaryCategory(work))}</td>
              <td>${escapeHtml(work.author)}</td>
              <td><input type="checkbox" data-featured="${escapeHtml(work.id)}" ${work.featured ? "checked" : ""}></td>
              <td><button class="nav-button" data-delete-work="${escapeHtml(work.id)}">删除</button></td>
            </tr>`).join("")}
        </tbody></table>
      `;
      content.querySelectorAll("[data-featured]").forEach(input => input.addEventListener("change", () => {
        app.findWork(input.dataset.featured).featured = input.checked;
        app.save();
        app.toast("works 表已更新");
      }));
      content.querySelectorAll("[data-delete-work]").forEach(button => button.addEventListener("click", () => {
        app.tables.works = app.tables.works.filter(work => work.id !== button.dataset.deleteWork);
        app.save();
        app.toast("作品已删除");
        render();
      }));
    }
    if (tab === "users") {
      content.innerHTML = `
        <h2>用户表</h2>
        <table class="table"><thead><tr><th>ID</th><th>昵称</th><th>邮箱</th><th>角色</th><th>点数</th></tr></thead><tbody>
          ${renderTableRows(app.tables.users, ["id", "name", "email", "role", "points"])}
        </tbody></table>
      `;
    }
    if (tab === "points") {
      content.innerHTML = `
        <h2>点数流水表</h2>
        <table class="table"><thead><tr><th>ID</th><th>用户</th><th>类型</th><th>数量</th><th>备注</th><th>日期</th></tr></thead><tbody>
          ${renderTableRows(app.tables.pointsRecords, ["id", "userId", "type", "amount", "note", "createdAt"])}
        </tbody></table>
      `;
    }
  }

  document.querySelectorAll("[data-admin-tab]").forEach(button => button.addEventListener("click", () => {
    tab = button.dataset.adminTab;
    render();
  }));
}

function initManagement() {
  const login = document.getElementById("management-login");
  const consoleView = document.getElementById("management-console");
  const content = document.getElementById("management-content");
  const auth = app.adminAuth();
  let tab = "overview";

  function showConsole() {
    login.classList.add("hidden");
    consoleView.classList.remove("hidden");
    render();
  }

  function tableRows(rows, columns) {
    return rows.map(row => `<tr>${columns.map(column => `<td>${escapeHtml(row[column] ?? "")}</td>`).join("")}</tr>`).join("");
  }

  function statCards() {
    const users = app.tables.users || [];
    const works = app.tables.works || [];
    const points = app.tables.pointsRecords || [];
    const featured = works.filter(work => work.featured).length;
    const totalHeat = works.reduce((sum, work) => sum + workPopularity(work), 0);
    const totalPoints = users.reduce((sum, user) => sum + Number(user.points || 0), 0);
    return `
      <section class="management-stats">
        <article><strong>${users.length}</strong><span>用户总数</span></article>
        <article><strong>${works.length}</strong><span>作品总数</span></article>
        <article><strong>${featured}</strong><span>首页精选</span></article>
        <article><strong>${totalHeat}</strong><span>作品总热度</span></article>
        <article><strong>${totalPoints}</strong><span>用户点数</span></article>
        <article><strong>${points.length}</strong><span>点数流水</span></article>
      </section>
    `;
  }

  function categorySummary() {
    const counts = {};
    app.tables.works.forEach(work => {
      workCategories(work).forEach(category => {
        counts[category] = (counts[category] || 0) + 1;
      });
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }

  function apiConfig() {
    if (!app.tables.apiConfigs.length) {
      app.tables.apiConfigs.push({
        id: makeId("api"),
        provider: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        apiKey: "",
        temperature: 0.35,
        enabled: true
      });
      app.save();
    }
    return app.tables.apiConfigs[0];
  }

  function userWorks(user) {
    return app.tables.works.filter(work => work.authorId === user.id || work.author === user.name);
  }

  function stableWorkSales(work, index) {
    if (work.sales !== undefined) return Number(work.sales || 0);
    const seed = String(work.id || work.title || "").split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return Math.max(0, Math.round((Number(work.points || 12) + seed % 37 + index * 3) / 4));
  }

  function userMetrics(user) {
    const works = userWorks(user);
    const records = app.tables.pointsRecords.filter(record => record.userId === user.id);
    const categories = works.reduce((map, work) => {
      workCategories(work).forEach(key => {
        map[key] = (map[key] || 0) + 1;
      });
      return map;
    }, {});
    const totalSales = works.reduce((sum, work, index) => sum + stableWorkSales(work, index), 0);
    const workRevenue = works.reduce((sum, work, index) => sum + stableWorkSales(work, index) * Number(work.points || 0), 0);
    const earnedRecords = records
      .filter(record => ["sale", "reward", "earn", "bonus"].includes(record.type))
      .reduce((sum, record) => sum + Number(record.amount || 0), 0);
    const recharged = records
      .filter(record => record.type === "recharge")
      .reduce((sum, record) => sum + Number(record.amount || 0), 0);
    const consumed = records
      .filter(record => record.type === "consume")
      .reduce((sum, record) => sum + Number(record.amount || 0), 0);
    const activityScore = Math.min(100, Number(user.activityScore ?? (works.length * 8 + records.length * 9 + totalSales)));
    return {
      works,
      records,
      categories,
      totalSales,
      workRevenue,
      earnedPoints: earnedRecords + workRevenue,
      ledgerEarned: earnedRecords,
      recharged,
      consumed,
      activityScore,
      lastOnline: user.lastActiveAt || user.lastLoginAt || user.joinedAt || "暂无记录",
      subscriptionPlan: user.subscriptionPlan || "Free",
      subscriptionStatus: user.subscriptionStatus || "free",
      subscriptionRenewAt: user.subscriptionRenewAt || "暂无"
    };
  }

  function categoryStatsHtml(categories) {
    const entries = Object.entries(categories);
    if (!entries.length) return `<span class="empty-note">暂无作品分类</span>`;
    return entries.map(([name, count]) => `
      <span class="category-stat"><strong>${count}</strong>${escapeHtml(name)}</span>
    `).join("");
  }

  function pointRecordsHtml(records) {
    if (!records.length) return `<tr><td colspan="4">暂无点数流水。</td></tr>`;
    return records.slice(0, 6).map(record => `
      <tr>
        <td>${escapeHtml(record.type)}</td>
        <td>${Number(record.amount || 0)}</td>
        <td>${escapeHtml(record.note || "")}</td>
        <td>${escapeHtml(record.createdAt || "")}</td>
      </tr>
    `).join("");
  }

  function renderOverview() {
    const latestWorks = [...app.tables.works].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).slice(0, 6);
    const latestUsers = [...app.tables.users].sort((a, b) => String(b.joinedAt || "").localeCompare(String(a.joinedAt || ""))).slice(0, 5);
    content.innerHTML = `
      <div class="management-head"><div><p class="kicker">Overview</p><h1>系统总览</h1><p>快速查看当前静态数据表状态，后续可按同一结构迁移到服务端数据库。</p></div></div>
      ${statCards()}
      <section class="management-grid">
        <article class="management-card">
          <h2>最新作品</h2>
          <table class="table"><thead><tr><th>作品</th><th>分类</th><th>作者</th><th>日期</th></tr></thead><tbody>
            ${latestWorks.map(work => `<tr><td>${escapeHtml(work.title)}</td><td>${escapeHtml(workCategories(work).join(" / "))}</td><td>${escapeHtml(work.author)}</td><td>${escapeHtml(work.createdAt)}</td></tr>`).join("")}
          </tbody></table>
        </article>
        <article class="management-card">
          <h2>新增用户</h2>
          <table class="table"><thead><tr><th>昵称</th><th>角色</th><th>点数</th><th>日期</th></tr></thead><tbody>
            ${latestUsers.map(user => `<tr><td>${escapeHtml(user.name)}</td><td>${escapeHtml(user.role)}</td><td>${Number(user.points || 0)}</td><td>${escapeHtml(user.joinedAt)}</td></tr>`).join("")}
          </tbody></table>
        </article>
      </section>
    `;
  }

  function renderUsers() {
    const rows = app.tables.users.map(user => {
      const metrics = userMetrics(user);
      const recentWorks = metrics.works.slice(0, 6);
      return `
        <article class="management-user-record" data-user-row="${escapeHtml(user.id)}">
          <div class="management-user-record-line management-user-record-top">
            <div class="management-user-cell">
              <img class="management-avatar" src="${escapeHtml(user.avatar || avatarOptions[0].src)}" alt="">
              <div>
                <strong>${escapeHtml(user.name)}</strong>
                <span>昵称由用户设置，后台只读</span>
              </div>
            </div>
            <label class="management-user-field">
              <span>唯一 ID</span>
              <input class="field compact-cell readonly-field" name="username" value="${escapeHtml(user.username || "")}" readonly aria-readonly="true" title="唯一 ID 不能由后台修改">
              <small>${escapeHtml(user.id)}</small>
            </label>
            <label class="management-user-field">
              <span>邮箱</span>
              <input class="field compact-cell" name="email" value="${escapeHtml(user.email || "")}">
            </label>
            <div class="management-user-metric"><span>活跃度</span><strong>${metrics.activityScore}</strong><small>最近 ${escapeHtml(metrics.lastOnline)}</small></div>
            <div class="management-user-metric"><span>作品数</span><strong>${metrics.works.length}</strong></div>
            <div class="management-user-metric"><span>销量</span><strong>${metrics.totalSales}</strong></div>
          </div>
          <div class="management-user-record-line management-user-record-bottom">
            <label class="management-user-field">
              <span>订阅方案</span>
              <select class="field compact-cell" name="subscriptionPlan">${optionList(subscriptionPlanOptions, metrics.subscriptionPlan)}</select>
            </label>
            <label class="management-user-field">
              <span>订阅状态</span>
              <select class="field compact-cell" name="subscriptionStatus">${optionList(subscriptionStatusOptions, metrics.subscriptionStatus)}</select>
            </label>
            <label class="management-user-field">
              <span>角色</span>
              <select class="field compact-cell" name="role"><option ${user.role === "admin" ? "selected" : ""}>admin</option><option ${user.role === "creator" ? "selected" : ""}>creator</option><option ${user.role === "member" ? "selected" : ""}>member</option></select>
            </label>
            <label class="management-user-field">
              <span>点数</span>
              <input class="field compact-cell" name="points" type="number" value="${Number(user.points || 0)}">
              <small>赚取 ${metrics.earnedPoints}</small>
            </label>
            <div class="management-user-actions">
              <button class="nav-button" data-toggle-user="${escapeHtml(user.id)}">详情</button>
              <button class="nav-button" data-save-user="${escapeHtml(user.id)}">保存</button>
              <button class="nav-button" data-delete-user="${escapeHtml(user.id)}">删除</button>
            </div>
          </div>
          <section class="management-user-detail hidden" data-user-detail="${escapeHtml(user.id)}">
              <div class="detail-head">
                <div>
                  <p class="kicker">User Detail</p>
                  <h2>${escapeHtml(user.name)} 的详细档案</h2>
                  <p>${escapeHtml(user.signature || user.bio || "该用户暂未填写签名。")}</p>
                </div>
                <span class="status-pill">${escapeHtml(metrics.subscriptionPlan)} · ${escapeHtml(metrics.subscriptionStatus)}</span>
              </div>
              <div class="detail-stat-grid">
                <article><strong>${metrics.activityScore}</strong><span>活跃度</span></article>
                <article><strong>${escapeHtml(metrics.lastOnline)}</strong><span>最近上线</span></article>
                <article><strong>${metrics.works.length}</strong><span>作品数量</span></article>
                <article><strong>${metrics.totalSales}</strong><span>作品销量</span></article>
                <article><strong>${Number(user.points || 0)}</strong><span>持有点数</span></article>
                <article><strong>${metrics.earnedPoints}</strong><span>赚取点数</span></article>
              </div>
              <div class="detail-grid">
                <article class="detail-card">
                  <h3>账号与订阅</h3>
                  <dl class="detail-list">
                    <dt>唯一 ID</dt><dd>${escapeHtml(user.username || "")}</dd>
                    <dt>邮箱</dt><dd>${escapeHtml(user.email || "")}</dd>
                    <dt>用户类型</dt><dd>${escapeHtml(user.accountType || "未设置")}</dd>
                    <dt>所属领域</dt><dd>${escapeHtml(user.field || "未设置")}</dd>
                    <dt>订阅到期</dt><dd>${escapeHtml(metrics.subscriptionRenewAt)}</dd>
                    <dt>注册时间</dt><dd>${escapeHtml(user.joinedAt || "")}</dd>
                  </dl>
                </article>
                <article class="detail-card">
                  <h3>作品种类统计</h3>
                  <div class="category-stat-row">${categoryStatsHtml(metrics.categories)}</div>
                  <h3>收益摘要</h3>
                  <dl class="detail-list compact">
                    <dt>作品收益估算</dt><dd>${metrics.workRevenue}</dd>
                    <dt>流水收益</dt><dd>${metrics.ledgerEarned}</dd>
                    <dt>充值点数</dt><dd>${metrics.recharged}</dd>
                    <dt>已消费点数</dt><dd>${metrics.consumed}</dd>
                  </dl>
                </article>
              </div>
              <div class="detail-grid">
                <article class="detail-card">
                  <h3>作品列表</h3>
                  <table class="table"><thead><tr><th>作品</th><th>分类</th><th>价格</th><th>销量</th></tr></thead><tbody>
                    ${recentWorks.length ? recentWorks.map((work, index) => `<tr><td>${escapeHtml(work.title)}</td><td>${escapeHtml(workCategories(work).join(" / "))}</td><td>${Number(work.points || 0)}</td><td>${stableWorkSales(work, index)}</td></tr>`).join("") : `<tr><td colspan="4">暂无作品。</td></tr>`}
                  </tbody></table>
                </article>
                <article class="detail-card">
                  <h3>点数流水</h3>
                  <table class="table"><thead><tr><th>类型</th><th>数量</th><th>备注</th><th>日期</th></tr></thead><tbody>${pointRecordsHtml(metrics.records)}</tbody></table>
                </article>
              </div>
          </section>
        </article>
      `;
    }).join("");
    content.innerHTML = `
      <div class="management-head"><div><p class="kicker">Users</p><h1>用户管理</h1><p>管理员不修改用户昵称；这里只维护平台运营字段，并查看用户活跃度、订阅、作品和点数数据。</p></div></div>
      <section class="management-card users-card">
        <div class="management-user-list">${rows}</div>
      </section>
    `;
    content.querySelectorAll("[data-toggle-user]").forEach(button => button.addEventListener("click", () => {
      const detail = content.querySelector(`[data-user-detail="${CSS.escape(button.dataset.toggleUser)}"]`);
      if (!detail) return;
      const isHidden = detail.classList.toggle("hidden");
      button.textContent = isHidden ? "详情" : "收起";
    }));
    content.querySelectorAll("[data-save-user]").forEach(button => button.addEventListener("click", async () => {
      const user = app.tables.users.find(item => item.id === button.dataset.saveUser);
      const row = content.querySelector(`[data-user-row="${CSS.escape(button.dataset.saveUser)}"]`);
      if (!user || !row) return;
      const payload = {
        email: row.querySelector('[name="email"]').value.trim(),
        subscriptionPlan: row.querySelector('[name="subscriptionPlan"]').value,
        subscriptionStatus: row.querySelector('[name="subscriptionStatus"]').value,
        role: row.querySelector('[name="role"]').value,
        points: Number(row.querySelector('[name="points"]').value || 0)
      };
      if (app.serverReady) {
        try {
          const saved = await serverApi.updateAdminUser(user.id, payload);
          Object.assign(user, saved.user);
          app.save();
          app.toast("用户运营字段已同步到服务器 users 表");
          render();
        } catch (error) {
          app.toast(error.message || "用户保存失败");
        }
        return;
      }
      Object.assign(user, payload);
      app.save();
      app.toast("用户运营字段已更新，昵称保持不变");
    }));
    content.querySelectorAll("[data-delete-user]").forEach(button => button.addEventListener("click", async () => {
      if (button.dataset.deleteUser === "u-admin") return app.toast("默认管理员不可删除");
      const user = app.tables.users.find(item => item.id === button.dataset.deleteUser);
      if (!user) return;
      const confirmed = confirm(`确定删除用户「${user.name}」吗？`);
      if (!confirmed) return;
      if (app.serverReady) {
        try {
          await serverApi.deleteAdminUser(user.id);
          app.tables.users = app.tables.users.filter(item => item.id !== user.id);
          app.tables.pointsRecords = app.tables.pointsRecords.filter(record => record.userId !== user.id);
          app.tables.works.forEach(work => {
            if (work.authorId === user.id) work.authorId = "";
          });
          app.save();
          app.toast("用户已从服务器 users 表删除");
          render();
        } catch (error) {
          app.toast(error.message || "用户删除失败");
        }
        return;
      }
      app.tables.users = app.tables.users.filter(item => item.id !== user.id);
      app.save();
      app.toast("用户已删除");
      render();
    }));
  }

  function renderReviews() {
    const reviewWorks = app.tables.works
      .filter(work => (work.status || "published") === "reviewing" && (work.sourceType || "user-upload") === "user-upload")
      .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
    content.innerHTML = `
      <div class="management-head"><div><p class="kicker">Review</p><h1>作品审核</h1><p>这里只处理最新上传且正在审核中的作品；通过后进入前台作品库，退回后保持隐藏。</p></div></div>
      <section class="management-card">
        ${reviewWorks.length ? `
          <div class="review-work-list">
            ${reviewWorks.map(work => `
              <article class="review-work-card" data-review-work="${escapeHtml(work.id)}">
                <img src="${escapeHtml(work.image)}" alt="">
                <div>
                  <div class="review-work-title">
                    <h2>${escapeHtml(work.title)}</h2>
                    <span class="status-pill">审核中</span>
                  </div>
                  <p>${escapeHtml(work.description || "该作品暂无简介。")}</p>
                  <dl class="review-work-meta">
                    <div><dt>作者</dt><dd>${escapeHtml(work.author)}</dd></div>
                    <div><dt>分类</dt><dd>${escapeHtml(workCategories(work).join(" / "))}</dd></div>
                    <div><dt>点数</dt><dd>${Number(work.points || 0)} pts</dd></div>
                    <div><dt>上传时间</dt><dd>${escapeHtml(work.createdAt || "")}</dd></div>
                    <div><dt>热度</dt><dd>${workPopularity(work)}</dd></div>
                  </dl>
                  <div class="tag-row">${(work.tags || []).slice(0, 6).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
                  <div class="stack-actions horizontal">
                    <a class="nav-button" href="work.html?id=${encodeURIComponent(work.id)}" target="_blank" rel="noopener">预览详情</a>
                    <button class="nav-button solid" data-review-approve="${escapeHtml(work.id)}">通过审核</button>
                    <button class="nav-button" data-review-reject="${escapeHtml(work.id)}">退回隐藏</button>
                  </div>
                </div>
              </article>
            `).join("")}
          </div>
        ` : `<p class="empty-note">暂无正在审核中的新上传作品。</p>`}
      </section>
    `;

    async function updateReviewStatus(id, status) {
      const work = app.tables.works.find(item => item.id === id);
      if (!work) return;
      const payload = {
        title: work.title,
        category: workPrimaryCategory(work),
        categories: workCategories(work),
        author: work.author,
        points: Number(work.points || 0),
        featured: Boolean(work.featured),
        status
      };
      try {
        const saved = await serverApi.updateAdminWork(work.id, payload);
        Object.assign(work, saved.work);
        app.save();
        app.toast(status === "published" ? "作品已通过审核并发布" : "作品已退回并隐藏");
        render();
      } catch (error) {
        app.toast(error.message || "审核操作失败");
      }
    }

    content.querySelectorAll("[data-review-approve]").forEach(button => {
      button.addEventListener("click", () => updateReviewStatus(button.dataset.reviewApprove, "published"));
    });
    content.querySelectorAll("[data-review-reject]").forEach(button => {
      button.addEventListener("click", () => updateReviewStatus(button.dataset.reviewReject, "hidden"));
    });
  }

  function renderWorks() {
    const statusLabel = status => ({
      published: "已发布",
      reviewing: "审核中",
      hidden: "已隐藏"
    })[status] || "已发布";
    content.innerHTML = `
      <div class="management-head"><div><p class="kicker">Works</p><h1>作品管理</h1><p>维护作品标题、分类、作者、精选状态和发布状态；服务器模式下会直接同步 works 数据表。</p></div></div>
      <section class="management-card management-works-card">
        <div class="management-work-toolbar">
          <label>
            <span>搜索作品</span>
            <input class="field" type="search" id="management-work-search" placeholder="输入作品名、作者、ID、标签">
          </label>
          <label>
            <span>状态筛选</span>
            <select class="field" id="management-work-status-filter">
              <option value="all">全部状态</option>
              <option value="published">已发布</option>
              <option value="reviewing">审核中</option>
              <option value="hidden">已隐藏</option>
            </select>
          </label>
          <strong id="management-work-count">${app.tables.works.length} 个作品</strong>
        </div>
        <div class="management-work-list">
          ${app.tables.works.map(work => {
            const categories = workCategories(work);
            const status = work.status || "published";
            const searchText = [
              work.title,
              work.id,
              work.author,
              work.description,
              ...categories,
              ...(work.tags || [])
            ].join(" ").toLowerCase();
            return `
              <article class="management-work-record" data-work-row="${escapeHtml(work.id)}" data-work-status="${escapeHtml(status)}" data-work-search="${escapeHtml(searchText)}">
                <div class="management-work-cover">
                  <img class="management-work-thumb" src="${escapeHtml(work.image)}" alt="">
                  <span>${escapeHtml(statusLabel(status))}</span>
                </div>
                <div class="management-work-body">
                  <div class="management-work-main">
                    <label class="management-work-field management-work-title-field">
                      <span>作品名称</span>
                      <input class="field compact-cell" name="title" value="${escapeHtml(work.title)}">
                      <small>${escapeHtml(work.id)}</small>
                    </label>
                    <label class="management-work-field">
                      <span>作者</span>
                      <input class="field compact-cell" name="author" value="${escapeHtml(work.author)}">
                    </label>
                    <label class="management-work-field">
                      <span>点数</span>
                      <input class="field compact-cell" name="points" type="number" value="${Number(work.points || 0)}">
                    </label>
                    <div class="management-work-field management-work-metric">
                      <span>热度</span>
                      <strong>${workPopularity(work)}</strong>
                      <small>系统统计</small>
                    </div>
                  </div>
                  <div class="management-work-secondary">
                    <div class="management-work-field management-work-category-field">
                      <span>分类</span>
                      <div class="management-category-grid">${renderCategorySelects(categories, { requiredFirst: true })}</div>
                    </div>
                    <label class="management-work-field">
                      <span>状态</span>
                      <select class="field compact-cell" name="status">
                        <option value="published" ${status === "published" ? "selected" : ""}>已发布</option>
                        <option value="reviewing" ${status === "reviewing" ? "selected" : ""}>审核中</option>
                        <option value="hidden" ${status === "hidden" ? "selected" : ""}>已隐藏</option>
                      </select>
                    </label>
                    <label class="management-work-field management-work-check">
                      <span>精选</span>
                      <input type="checkbox" name="featured" ${work.featured ? "checked" : ""}>
                      <small>推荐展示</small>
                    </label>
                  </div>
                </div>
                <div class="management-work-actions">
                  <a class="nav-button" href="work.html?id=${encodeURIComponent(work.id)}" target="_blank" rel="noopener">查看</a>
                  <button class="nav-button solid" data-save-work="${escapeHtml(work.id)}">保存</button>
                  <button class="nav-button danger" data-delete-work="${escapeHtml(work.id)}">删除</button>
                </div>
              </article>
            `;
          }).join("")}
        </div>
      </section>
    `;
    const searchInput = content.querySelector("#management-work-search");
    const statusFilter = content.querySelector("#management-work-status-filter");
    const countNode = content.querySelector("#management-work-count");
    const applyWorkFilters = () => {
      const term = String(searchInput?.value || "").trim().toLowerCase();
      const status = String(statusFilter?.value || "all");
      let visible = 0;
      content.querySelectorAll(".management-work-record").forEach(record => {
        const matchesText = !term || String(record.dataset.workSearch || "").includes(term);
        const matchesStatus = status === "all" || record.dataset.workStatus === status;
        const show = matchesText && matchesStatus;
        record.classList.toggle("hidden", !show);
        if (show) visible += 1;
      });
      if (countNode) countNode.textContent = `${visible} / ${app.tables.works.length} 个作品`;
    };
    searchInput?.addEventListener("input", applyWorkFilters);
    statusFilter?.addEventListener("change", applyWorkFilters);
    content.querySelectorAll("[data-save-work]").forEach(button => button.addEventListener("click", async () => {
      const work = app.tables.works.find(item => item.id === button.dataset.saveWork);
      const row = content.querySelector(`[data-work-row="${CSS.escape(button.dataset.saveWork)}"]`);
      if (!work || !row) return;
      const selectedCategories = selectedCategoriesFrom(row);
      const payload = {
        title: row.querySelector('[name="title"]').value.trim() || work.title,
        category: selectedCategories[0] || work.category,
        categories: selectedCategories,
        author: row.querySelector('[name="author"]').value.trim() || work.author,
        points: Number(row.querySelector('[name="points"]').value || 0),
        featured: row.querySelector('[name="featured"]').checked,
        status: row.querySelector('[name="status"]').value
      };
      if (app.serverReady) {
        try {
          const saved = await serverApi.updateAdminWork(work.id, payload);
          Object.assign(work, saved.work);
          app.save();
          app.toast("作品已同步保存到服务器 works 表");
          render();
        } catch (error) {
          app.toast(error.message || "作品保存失败");
        }
        return;
      }
      Object.assign(work, payload);
      app.save();
      app.toast("作品表已更新");
    }));
    content.querySelectorAll("[data-delete-work]").forEach(button => button.addEventListener("click", async () => {
      const work = app.tables.works.find(item => item.id === button.dataset.deleteWork);
      if (!work) return;
      const confirmed = confirm(`确定删除「${work.title}」吗？删除后首页和社区将不再显示。`);
      if (!confirmed) return;
      if (app.serverReady) {
        try {
          await serverApi.deleteAdminWork(work.id);
          app.tables.works = app.tables.works.filter(item => item.id !== work.id);
          app.save();
          app.toast("作品已从服务器 works 表删除");
          render();
        } catch (error) {
          app.toast(error.message || "作品删除失败");
        }
        return;
      }
      app.tables.works = app.tables.works.filter(work => work.id !== button.dataset.deleteWork);
      app.save();
      app.toast("作品已删除");
      render();
    }));
  }

  function renderStats() {
    const categories = categorySummary();
    const max = Math.max(...categories.map(item => item[1]), 1);
    const authorCounts = {};
    app.tables.works.forEach(work => {
      authorCounts[work.author || "未知作者"] = (authorCounts[work.author || "未知作者"] || 0) + 1;
    });
    const heatRows = app.tables.works
      .map(work => ({ work, heat: workPopularity(work) }))
      .sort((a, b) => b.heat - a.heat || String(a.work.title || "").localeCompare(String(b.work.title || ""), "zh-Hans-CN"));
    const totalHeat = heatRows.reduce((sum, item) => sum + item.heat, 0);
    const publishedHeat = app.tables.works.filter(isWorkPublished).reduce((sum, work) => sum + workPopularity(work), 0);
    const averageHeat = app.tables.works.length ? Math.round(totalHeat / app.tables.works.length) : 0;
    const topHeat = heatRows[0]?.heat || 0;
    content.innerHTML = `
      <div class="management-head"><div><p class="kicker">Analytics</p><h1>数据统计</h1><p>用于运营判断的轻量统计视图，包括分类分布、作者贡献、作品热度和数据健康状态。</p></div></div>
      ${statCards()}
      <section class="management-grid">
        <article class="management-card">
          <h2>分类分布</h2>
          <div class="bar-list">${categories.map(([name, count]) => `<div><span>${escapeHtml(name)}</span><strong>${count}</strong><i style="width:${Math.round(count / max * 100)}%"></i></div>`).join("")}</div>
        </article>
        <article class="management-card">
          <h2>作者贡献</h2>
          <table class="table"><thead><tr><th>作者</th><th>作品数</th></tr></thead><tbody>
            ${Object.entries(authorCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => `<tr><td>${escapeHtml(name)}</td><td>${count}</td></tr>`).join("")}
          </tbody></table>
        </article>
        <article class="management-card">
          <h2>热度概览</h2>
          <dl class="heat-summary-list">
            <div><dt>作品总热度</dt><dd>${totalHeat}</dd></div>
            <div><dt>已发布热度</dt><dd>${publishedHeat}</dd></div>
            <div><dt>平均热度</dt><dd>${averageHeat}</dd></div>
            <div><dt>最高热度</dt><dd>${topHeat}</dd></div>
          </dl>
        </article>
        <article class="management-card">
          <h2>作品热度排行</h2>
          <div class="heat-rank-list">
            ${heatRows.slice(0, 10).map(({ work, heat }, index) => `
              <div class="heat-rank-item">
                <span>${index + 1}</span>
                <div><strong>${escapeHtml(work.title)}</strong><small>${escapeHtml(workPrimaryCategory(work))} · ${escapeHtml(work.author)}</small></div>
                <em>${heat}</em>
              </div>`).join("") || `<p class="empty-note">暂无热度数据。</p>`}
          </div>
        </article>
      </section>
    `;
  }

  function renderApi() {
    const api = apiConfig();
    const prompts = app.uploadCopyPrompts();
    const apiKeyPlaceholder = api.apiKeyConfigured ? "已保存 API Key，留空则保持不变" : "API Key";
    const apiKeyState = api.apiKeyConfigured
      ? `服务器已保存 API Key（${escapeHtml(api.apiKeySource || "database")}，${Number(api.apiKeyLength || 0)} 位）；留空不会覆盖。`
      : "尚未保存 API Key，做同款功能无法调用模型。";
    content.innerHTML = `
      <div class="management-head"><div><p class="kicker">API</p><h1>API 管理</h1><p>默认接入 DeepSeek。服务器模式会保存到 api_configs 表，后续可由云端代理读取并调用。</p></div></div>
      <section class="management-card">
        <form id="management-api-form" class="form-grid">
          <input class="field" name="provider" value="${escapeHtml(api.provider)}" placeholder="服务商">
          <input class="field" name="model" value="${escapeHtml(api.model)}" placeholder="模型">
          <input class="field full" name="baseUrl" value="${escapeHtml(api.baseUrl)}" placeholder="Base URL">
          <input class="field full" name="apiKey" value="" placeholder="${escapeHtml(apiKeyPlaceholder)}" autocomplete="off">
          <p class="form-help full">${apiKeyState}</p>
          <input class="field" name="temperature" type="number" min="0" max="2" step="0.05" value="${Number(api.temperature || 0)}">
          <label class="check-line"><input type="checkbox" name="enabled" ${api.enabled ? "checked" : ""}> 启用该配置</label>
          <button class="nav-button solid" type="submit">保存 API 配置</button>
          <button class="nav-button" type="button" id="api-cloud-check">云端校验</button>
        </form>
      </section>
      <section class="management-card">
        <div class="management-head compact"><div><p class="kicker">Prompts</p><h2>上传文案提示词</h2><p>用于上传作品页生成“功能亮点”“适用场景”“作者说明”。支持变量：{title}、{categories}、{description}、{tags}。</p></div></div>
        <form id="upload-copy-prompts-form" class="form-grid">
          <label class="field-group full">
            <span>功能亮点提示词</span>
            <textarea class="field textarea" name="highlights">${escapeHtml(prompts.highlights || "")}</textarea>
          </label>
          <label class="field-group full">
            <span>适用场景提示词</span>
            <textarea class="field textarea" name="useCases">${escapeHtml(prompts.useCases || "")}</textarea>
          </label>
          <label class="field-group full">
            <span>作者说明提示词</span>
            <textarea class="field textarea" name="creatorNote">${escapeHtml(prompts.creatorNote || "")}</textarea>
          </label>
          <button class="nav-button solid" type="submit">保存提示词</button>
        </form>
      </section>
    `;
    document.getElementById("management-api-form").addEventListener("submit", async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget).entries());
      const payload = {
        provider: data.provider,
        model: data.model,
        baseUrl: data.baseUrl,
        apiKey: String(data.apiKey || "").trim(),
        enabled: Boolean(data.enabled),
        temperature: Number(data.temperature || 0)
      };
      if (app.serverReady) {
        try {
          const saved = await serverApi.updateAdminApiConfig(api.id || "deepseek-default", payload);
          app.tables.apiConfigs = saved.apiConfigs || [saved.apiConfig].filter(Boolean);
          app.save();
          app.toast("API 配置已同步到服务器 api_configs 表");
          render();
        } catch (error) {
          app.toast(error.message || "API 配置保存失败");
        }
        return;
      }
      Object.assign(api, payload);
      app.save();
      app.toast("API 配置已保存");
    });
    document.getElementById("api-cloud-check").addEventListener("click", async () => {
      if (app.serverReady) {
        try {
          const result = await serverApi.checkAdminApiConfig(api.id || "deepseek-default", { live: true });
          const check = result.check || {};
          app.toast(`云端校验${check.ok ? "通过" : "失败"}：${check.message || "无返回信息"}`, check.ok ? "success" : "error");
          return;
        } catch (error) {
          app.toast(error.message || "云端校验失败", "error");
          return;
        }
      }
      app.toast(api.baseUrl && api.model ? "配置字段完整；请在服务器模式下进行云端校验" : "请补齐 Base URL 和模型名称");
    });
    document.getElementById("upload-copy-prompts-form").addEventListener("submit", async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget).entries());
      const payload = {
        highlights: String(data.highlights || ""),
        useCases: String(data.useCases || ""),
        creatorNote: String(data.creatorNote || "")
      };
      if (app.serverReady) {
        try {
          const saved = await serverApi.updateUploadCopyPrompts(payload);
          if (Array.isArray(saved.settings)) app.tables.settings = saved.settings;
          else upsertById(app.tables.settings, { id: "uploadCopyPrompts", ...saved.prompts });
          app.save();
          app.toast("上传文案提示词已同步到服务器", "success");
          render();
        } catch (error) {
          app.toast(error.message || "提示词保存失败", "error");
        }
        return;
      }
      upsertById(app.tables.settings, { id: "uploadCopyPrompts", ...payload });
      app.save();
      app.toast("上传文案提示词已保存");
    });
  }

  function renderPoints() {
    content.innerHTML = `
      <div class="management-head"><div><p class="kicker">Points</p><h1>点数流水</h1><p>记录充值、消耗、奖励等点数变化，并同步用户余额。</p></div></div>
      <section class="management-card">
        <form id="management-points-form" class="form-grid">
          <select class="field" name="userId">${app.tables.users.map(user => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)} · ${escapeHtml(user.id)}</option>`).join("")}</select>
          <select class="field" name="type"><option value="recharge">recharge</option><option value="consume">consume</option><option value="reward">reward</option><option value="adjust">adjust</option></select>
          <input class="field" name="amount" type="number" placeholder="数量" required>
          <input class="field" name="note" placeholder="备注">
          <button class="nav-button solid" type="submit">写入流水</button>
        </form>
      </section>
      <section class="management-card">
        <table class="table"><thead><tr><th>ID</th><th>用户</th><th>类型</th><th>数量</th><th>备注</th><th>日期</th></tr></thead><tbody>
          ${tableRows(app.tables.pointsRecords, ["id", "userId", "type", "amount", "note", "createdAt"])}
        </tbody></table>
      </section>
    `;
    document.getElementById("management-points-form").addEventListener("submit", async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget).entries());
      const amount = Number(data.amount || 0);
      const user = app.tables.users.find(item => item.id === data.userId);
      if (app.serverReady) {
        try {
          const saved = await serverApi.createAdminPointRecord({
            userId: data.userId,
            type: data.type,
            amount,
            note: data.note || "后台调整"
          });
          app.tables.pointsRecords.unshift(saved.record);
          upsertById(app.tables.users, saved.user);
          app.save();
          app.toast("点数流水已同步到服务器 points_records 表");
          render();
        } catch (error) {
          app.toast(error.message || "点数流水写入失败");
        }
        return;
      }
      app.tables.pointsRecords.unshift({ id: makeId("p"), userId: data.userId, type: data.type, amount, note: data.note || "后台调整", createdAt: new Date().toISOString().slice(0, 10) });
      if (user) user.points = Number(user.points || 0) + (data.type === "consume" ? -amount : amount);
      app.save();
      app.toast("点数流水已写入");
      render();
    });
  }

  function renderSettings() {
    const site = app.site();
    const admin = app.adminAuth();
    const categories = appCategories();
    content.innerHTML = `
      <div class="management-head"><div><p class="kicker">Settings</p><h1>站点设置</h1><p>维护站点基础文案和后台账号。上线后建议迁移到服务器环境变量或配置表。</p></div></div>
      <section class="management-card">
        <form id="management-settings-form" class="form-grid">
          <input class="field" name="siteName" value="${escapeHtml(site.siteName)}" placeholder="站点名称">
          <input class="field" name="announcement" value="${escapeHtml(site.announcement)}" placeholder="公告">
          <textarea class="field textarea full" name="tagline" placeholder="站点说明">${escapeHtml(site.tagline)}</textarea>
          <input class="field" name="username" value="${escapeHtml(admin.username)}" placeholder="后台用户名">
          <input class="field" name="password" value="${escapeHtml(admin.password)}" placeholder="后台密码">
          <div class="form-section-head full">
            <p class="kicker">Categories</p>
            <h2>作品分类</h2>
          </div>
          <div class="management-category-name-grid full">
            ${categories.map((category, index) => `
              <label>
                <span>分类 ${index + 1}</span>
                <input class="field" name="categories" value="${escapeHtml(category)}" maxlength="16" required>
              </label>
            `).join("")}
          </div>
          <button class="nav-button solid" type="submit">保存设置</button>
        </form>
      </section>
    `;
    document.getElementById("management-settings-form").addEventListener("submit", async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget).entries());
      data.categories = Array.from(event.currentTarget.querySelectorAll('[name="categories"]')).map(input => input.value.trim());
      if (app.serverReady) {
        try {
          const saved = await serverApi.updateAdminSettings(data);
          app.tables.settings = saved.settings;
          app.tables.categories = normalizeCategoryNames(data.categories);
          app.save();
          app.toast("站点设置已同步到服务器 settings 表");
          render();
        } catch (error) {
          app.toast(error.message || "站点设置保存失败");
        }
        return;
      }
      Object.assign(site, { siteName: data.siteName, announcement: data.announcement, tagline: data.tagline });
      Object.assign(admin, { username: data.username || "admin", password: data.password || "admin1212" });
      app.tables.categories = normalizeCategoryNames(data.categories);
      upsertById(app.tables.settings, { id: "workCategories", categories: app.tables.categories });
      app.save();
      app.toast("站点设置已保存");
    });
  }

  function renderDataTools() {
    content.innerHTML = `
      <div class="management-head"><div><p class="kicker">Data</p><h1>数据工具</h1><p>导出、查看、恢复或重置本地数据。重置会回到当前代码中的种子表。</p></div></div>
      <section class="management-card">
        <div class="stack-actions horizontal">
          <button class="nav-button solid" id="export-json">生成导出 JSON</button>
          <button class="nav-button" id="download-json">下载 JSON</button>
          <button class="nav-button" id="restore-json">从文本恢复</button>
          <button class="nav-button" id="reset-local-data">重置本地数据</button>
        </div>
        <textarea class="field textarea data-textarea" id="data-json" spellcheck="false">${escapeHtml(JSON.stringify(app.tables, null, 2))}</textarea>
      </section>
    `;
    const textarea = document.getElementById("data-json");
    document.getElementById("export-json").addEventListener("click", () => {
      textarea.value = JSON.stringify(app.tables, null, 2);
      app.toast("已生成当前数据快照");
    });
    document.getElementById("download-json").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(app.tables, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `coding-community-data-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    });
    document.getElementById("restore-json").addEventListener("click", () => {
      try {
        app.tables = JSON.parse(textarea.value);
        app.save();
        app.toast("数据已从文本恢复");
        render();
      } catch {
        app.toast("JSON 格式不正确，未恢复");
      }
    });
    document.getElementById("reset-local-data").addEventListener("click", () => {
      localStorage.removeItem(db.key);
      app.toast("本地数据已重置，页面即将刷新");
      setTimeout(() => location.reload(), 600);
    });
  }

  function render() {
    document.querySelectorAll("[data-management-tab]").forEach(button => button.classList.toggle("active", button.dataset.managementTab === tab));
    if (tab === "overview") renderOverview();
    if (tab === "users") renderUsers();
    if (tab === "reviews") renderReviews();
    if (tab === "works") renderWorks();
    if (tab === "stats") renderStats();
    if (tab === "api") renderApi();
    if (tab === "points") renderPoints();
    if (tab === "settings") renderSettings();
    if (tab === "data") renderDataTools();
  }

  const locallyAuthed = localStorage.getItem("codingCommunityManagementAuthed") === "true";
  if (locallyAuthed && (!app.serverReady || serverApi.adminToken)) {
    showConsole();
  } else if (locallyAuthed && app.serverReady && !serverApi.adminToken) {
    localStorage.removeItem("codingCommunityManagementAuthed");
  }

  document.getElementById("management-login-form").addEventListener("submit", async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (app.serverReady) {
      try {
        const payload = await serverApi.adminLogin(data);
        serverApi.setAdminToken(payload.token);
        localStorage.setItem("codingCommunityManagementAuthed", "true");
        showConsole();
      } catch (error) {
        app.toast(error.message || "后台账号或密码错误");
      }
      return;
    }
    if (data.username === auth.username && data.password === auth.password) {
      localStorage.setItem("codingCommunityManagementAuthed", "true");
      showConsole();
    } else {
      app.toast("后台账号或密码错误");
    }
  });

  document.getElementById("management-logout").addEventListener("click", () => {
    localStorage.removeItem("codingCommunityManagementAuthed");
    serverApi.clearAdminToken();
    location.reload();
  });

  document.querySelectorAll("[data-management-tab]").forEach(button => button.addEventListener("click", () => {
    tab = button.dataset.managementTab;
    render();
  }));
}

document.addEventListener("DOMContentLoaded", async () => {
  const runners = {
    home: initHome,
    community: initCommunity,
    upload: initUpload,
    work: initWork,
    vibe: initVibe,
    mine: initMine,
    admin: initAdmin,
    management: initManagement
  };
  try {
    await app.initBackend();
    applySiteChrome();
    wireGlobalAuth();
    wireWorkEngagements();
    await runners[document.body.dataset.page]?.();
  } catch (error) {
    app.toast(error.message || "页面初始化失败");
  }
});
