// ==== Config ====
const APP_VERSION = "1.13";
const SB_URL = "https://ljwlanwmnuqgxftlirhh.supabase.co";
const SB_KEY = "sb_publishable_niVre5BYps9QZVh4qq0UtQ_mMmCrIV0";

// ==== Storage local (cache + config) ====
const KEY_CACHE = "sueldo.cache";
const KEY_CRED = "sueldo.credId";
const KEY_VALOR = "sueldo.valorHora";
const KEY_CHECK = "sueldo.checkTime";

const getCache = () => JSON.parse(localStorage.getItem(KEY_CACHE) || "[]");
const setCache = (m) => localStorage.setItem(KEY_CACHE, JSON.stringify(m));
// Cache de valor_hora desde Supabase. Fallback a localStorage si no hay red.
let valoresHoraCache = JSON.parse(localStorage.getItem("sueldo.valoresCache") || "[]"); // [{mes, valor}]

function mesKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function getValorHoraForDate(date) {
  const key = mesKey(date);
  const exact = valoresHoraCache.find(v => v.mes === key);
  if (exact) return Number(exact.valor);
  // Fallback: valor más reciente anterior o igual
  const sorted = [...valoresHoraCache].sort((a, b) => b.mes.localeCompare(a.mes));
  const prev = sorted.find(v => v.mes <= key);
  if (prev) return Number(prev.valor);
  return Number(localStorage.getItem(KEY_VALOR) || 19000);
}

const getValorHora = () => getValorHoraForDate(new Date());
const setValorHora = (v) => localStorage.setItem(KEY_VALOR, String(v));
const getCheckTime = () => localStorage.getItem(KEY_CHECK) || "18:00";
const setCheckTime = (t) => localStorage.setItem(KEY_CHECK, t);

// ==== Format ====
const fmt = (n) => "$" + Math.round(n).toLocaleString("es-AR");
const hoyISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const hoyLabel = () => new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "short" });
const fmtDiaMes = (d) => d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" });
const isWeekday = (d) => { const x = d.getDay(); return x >= 1 && x <= 5; };

// ==== Supabase REST ====
const sbHeaders = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

function sbRowToMov(r) {
  return {
    id: r.id,
    fecha: r.fecha,
    tipo: r.tipo,
    horas: r.horas != null ? Number(r.horas) : null,
    monto: Number(r.monto),
    desc: r.descripcion,
  };
}

async function sbFetchAll() {
  const res = await fetch(`${SB_URL}/rest/v1/movimientos?select=*&order=fecha.desc`, { headers: sbHeaders });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const rows = await res.json();
  return rows.map(sbRowToMov);
}

async function sbInsert(mov) {
  const body = {
    fecha: mov.fecha,
    tipo: mov.tipo,
    horas: mov.horas,
    monto: mov.monto,
    descripcion: mov.desc,
  };
  const res = await fetch(`${SB_URL}/rest/v1/movimientos`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`insert ${res.status}: ${await res.text()}`);
  const [created] = await res.json();
  return sbRowToMov(created);
}

async function sbFetchValoresHora() {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/valor_hora?select=*&order=mes.desc`, { headers: sbHeaders });
    if (!res.ok) throw new Error(res.status);
    const rows = await res.json();
    valoresHoraCache = rows.map(r => ({ mes: r.mes, valor: Number(r.valor) }));
    localStorage.setItem("sueldo.valoresCache", JSON.stringify(valoresHoraCache));
    return valoresHoraCache;
  } catch (e) {
    console.warn("fetch valor_hora:", e);
    return valoresHoraCache;
  }
}

async function sbRecalcHorasMes(mes, valor) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/recalc_horas_mes`, {
    method: "POST",
    headers: { ...sbHeaders },
    body: JSON.stringify({ p_mes: mes, p_valor: valor }),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sbDelete(id) {
  const res = await fetch(`${SB_URL}/rest/v1/movimientos?id=eq.${id}`, {
    method: "DELETE",
    headers: sbHeaders,
  });
  if (!res.ok) throw new Error(`delete ${res.status}`);
}

async function sbLastHorasFecha() {
  const res = await fetch(
    `${SB_URL}/rest/v1/movimientos?select=fecha&tipo=eq.horas&order=fecha.desc&limit=1`,
    { headers: sbHeaders }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0]?.fecha || null;
}

// Días hábiles pendientes de registrar (desde día siguiente al último horas hasta hoy inclusive)
async function pendingWeekdays() {
  const last = await sbLastHorasFecha();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let start;
  if (last) {
    start = new Date(last);
    start.setDate(start.getDate() + 1);
    start.setHours(0, 0, 0, 0);
  } else {
    start = new Date(today);
  }

  const pending = [];
  const cur = new Date(start);
  while (cur <= today) {
    if (isWeekday(cur)) pending.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return pending;
}

// ==== WebAuthn ====
const b64urlEncode = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDecode = (str) => {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
};

async function registerFaceId() {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: "Sueldo", id: location.hostname },
      user: { id: userId, name: "thomas", displayName: "Thomas" },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }, { alg: -257, type: "public-key" }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
      timeout: 60000,
      attestation: "none",
    },
  });
  if (!cred) throw new Error("No se pudo registrar");
  localStorage.setItem(KEY_CRED, b64urlEncode(cred.rawId));
}

async function authFaceId() {
  const credIdStr = localStorage.getItem(KEY_CRED);
  if (!credIdStr) throw new Error("NO_CRED");
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ id: b64urlDecode(credIdStr), type: "public-key" }],
      userVerification: "required",
      timeout: 60000,
    },
  });
  if (!assertion) throw new Error("Auth falló");
}

// ==== UI refs ====
const $ = (id) => document.getElementById(id);
const lockScreen = $("lock-screen");
const appScreen = $("app");
const quickScreen = $("quick-action");

// ==== Quick actions (URLs ?action=) ====
async function showQuick(icon, title, msg, allowClose = true) {
  quickScreen.classList.remove("hidden");
  lockScreen.classList.add("hidden");
  appScreen.classList.add("hidden");
  $("qa-icon").textContent = icon;
  $("qa-title").textContent = title;
  $("qa-msg").textContent = msg;
  $("qa-close").classList.toggle("hidden", !allowClose);
}

async function confirmarPendientesBatch() {
  const pending = await pendingWeekdays();
  if (pending.length === 0) return { count: 0 };
  const valor = getValorHora();
  const created = [];
  for (const d of pending) {
    const iso = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 18, 0, 0).toISOString();
    const label = d.toLocaleDateString("es-AR", { day: "2-digit", month: "short" });
    const row = await sbInsert({
      fecha: iso,
      tipo: "horas",
      horas: 9,
      monto: 9 * valor,
      desc: `Jornada ${label} (9-18hs)`,
    });
    created.push(row);
  }
  return { count: pending.length, total: pending.length * 9 * valor, valor };
}

async function quickConfirmar() {
  await showQuick("⏳", "Registrando jornadas...", "");
  try {
    const { count, total, valor } = await confirmarPendientesBatch();
    if (count === 0) {
      await showQuick("✓", "Nada que registrar", "No había jornadas pendientes.");
    } else if (count === 1) {
      await showQuick("✓", "Jornada registrada", `9hs × ${fmt(valor)} = ${fmt(total)}`);
    } else {
      await showQuick("✓", "Registrado", `${count} jornadas × 9hs = ${fmt(total)}`);
    }
    setTimeout(() => window.close(), 4000);
  } catch (e) {
    await showQuick("⚠️", "Error", `No se pudo registrar: ${e.message}`);
  }
}

async function quickSueldo() {
  await showQuick("⏳", "Registrando sueldo...", "");
  try {
    const monto = 2750000;
    const mes = new Date().toLocaleDateString("es-AR", { month: "long", year: "numeric" });
    await sbInsert({
      fecha: new Date().toISOString(),
      tipo: "ingreso",
      horas: null,
      monto,
      desc: `Sueldo ${mes} (incluye +$1M)`,
    });
    await showQuick("✓", "Sueldo registrado", `${fmt(monto)} sumado al saldo.`);
    setTimeout(() => window.close(), 4000);
  } catch (e) {
    await showQuick("⚠️", "Error", e.message);
  }
}

async function quickComision() {
  const txt = prompt("Monto total de comisiones este mes:", "");
  if (!txt) { await showQuick("✓", "Cancelado", ""); setTimeout(() => window.close(), 4000); return; }
  const n = Number(txt);
  if (!n || n <= 0) { await showQuick("⚠️", "Inválido", "Monto inválido"); return; }
  await showQuick("⏳", "Registrando comisión...", "");
  try {
    const mes = new Date().toLocaleDateString("es-AR", { month: "long", year: "numeric" });
    await sbInsert({
      fecha: new Date().toISOString(),
      tipo: "ingreso",
      horas: null,
      monto: n,
      desc: `Comisiones ${mes}`,
    });
    await showQuick("✓", "Comisión registrada", `${fmt(n)} sumado al saldo.`);
    setTimeout(() => window.close(), 4000);
  } catch (e) {
    await showQuick("⚠️", "Error", e.message);
  }
}

async function quickEditar() {
  const txt = prompt("¿Cuántas horas trabajaste hoy?", "9");
  if (!txt) { await showQuick("✓", "Cancelado", "No se registró nada."); return; }
  const h = Number(txt);
  if (!h || h <= 0) { await showQuick("⚠️", "Valor inválido", "Probá de nuevo."); return; }
  const desc = prompt("Descripción (opcional):", `Jornada ${hoyLabel()}`) || `Jornada ${hoyLabel()}`;
  await showQuick("⏳", "Registrando...", "");
  try {
    const valor = getValorHora();
    await sbInsert({
      fecha: new Date().toISOString(),
      tipo: "horas",
      horas: h,
      monto: h * valor,
      desc,
    });
    await showQuick("✓", "Jornada registrada", `${h}hs × ${fmt(valor)} = ${fmt(h * valor)}`);
    setTimeout(() => window.close(), 4000);
  } catch (e) {
    await showQuick("⚠️", "Error", `No se pudo registrar: ${e.message}`);
  }
}

$("qa-close").addEventListener("click", () => window.close());

// ==== Lock flow ====
const btnUnlock = $("btn-unlock");
const btnSetup = $("btn-setup");
const lockMsg = $("lock-msg");
const lockError = $("lock-error");

async function showApp() {
  lockScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  quickScreen.classList.add("hidden");
  $("valor-hora-screen").classList.add("hidden");
  await Promise.all([syncFromSupabase(), sbFetchValoresHora()]);
  render();
  checkConfirmBanner();
  startBannerPolling();
}

function showLock(message) {
  appScreen.classList.add("hidden");
  lockScreen.classList.remove("hidden");
  quickScreen.classList.add("hidden");
  stopBannerPolling();
  const hasCred = !!localStorage.getItem(KEY_CRED);
  btnUnlock.classList.toggle("hidden", !hasCred);
  btnSetup.classList.toggle("hidden", hasCred);
  lockMsg.textContent = hasCred ? "Desbloqueá con Face ID" : "Configurá Face ID para proteger la app";
  lockError.textContent = message || "";
}

btnUnlock.addEventListener("click", async () => {
  lockError.textContent = "";
  try { await authFaceId(); await showApp(); }
  catch { lockError.textContent = "No se pudo verificar. Probá de nuevo."; }
});

btnSetup.addEventListener("click", async () => {
  lockError.textContent = "";
  try { await registerFaceId(); await authFaceId(); await showApp(); }
  catch (e) { lockError.textContent = "No se pudo configurar: " + (e.message || e); }
});

const btnLockEl = $("btn-lock");
if (btnLockEl) btnLockEl.addEventListener("click", () => showLock());

// ==== Sync ====
async function syncFromSupabase() {
  try {
    const rows = await sbFetchAll();
    setCache(rows);
    render();
  } catch (e) {
    console.warn("Sync falló, usando cache:", e);
    render();
  }
}

// ==== Add form (ingreso / egreso / compra inversión) ====
let tipoActivo = "ingreso";
const tabs = document.querySelectorAll(".tab");
const inputValor = $("input-valor");
const inputDesc = $("input-desc");
const inputTicker = $("input-ticker");
const inputCantidad = $("input-cantidad");
const inputPrecio = $("input-precio");
const inputFecha = $("input-fecha");
const inputFechaMov = $("input-fecha-mov");
const inputRatio = $("input-ratio");
const fieldsDefault = document.querySelector(".fields-default");
const fieldsCompra = document.querySelector(".fields-compra");
const compraTipoTabs = document.querySelectorAll("#compra-tipo .subtab");

// Tipo de activo en la solapa de compra: "cedear" | "accion_us" | "usd"
let compraTipo = "cedear";

function setCompraTipo(ct) {
  compraTipo = ct;
  compraTipoTabs.forEach(b => b.classList.toggle("active", b.dataset.ct === ct));

  const rowTicker = $("row-ticker");
  const fieldRatio = $("field-ratio");
  const labelCantidad = $("label-cantidad");
  const labelPrecio = $("label-precio");

  // USD cash: ticker fijo, sin ratio; precio = tipo de cambio.
  if (rowTicker) rowTicker.classList.toggle("hidden", ct === "usd");
  if (fieldRatio) fieldRatio.classList.toggle("hidden", ct !== "cedear");

  if (labelCantidad) labelCantidad.textContent = ct === "usd" ? "Cantidad (USD)" : "Cantidad";
  if (labelPrecio) {
    labelPrecio.textContent =
      ct === "usd" ? "Tipo de cambio ARS / USD"
      : ct === "accion_us" ? "Precio USD / unidad"
      : "Precio ARS / unidad";
  }
  if (ct === "cedear") autofillRatio();
  // Al cambiar de tipo, el precio cambia de moneda: si lo había puesto la sugerencia,
  // lo descarto y vuelvo a sugerir. Un precio cargado a mano se respeta.
  if (precioAutocompletado) { inputPrecio.value = ""; precioAutocompletado = false; }
  updateCompraPreview();
  sugerirPrecioCompra();
}
compraTipoTabs.forEach(b => b.addEventListener("click", () => setCompraTipo(b.dataset.ct)));

// Autocompleta el ratio si el ticker ya es conocido (no vuelve a preguntar).
function autofillRatio() {
  if (!inputRatio) return;
  const t = inputTicker.value.trim().toUpperCase();
  const r = t ? ratioConocido(t) : null;
  if (r) {
    inputRatio.value = r;
    inputRatio.placeholder = `${r} (conocido)`;
  } else {
    inputRatio.value = "";
    inputRatio.placeholder = "ej. 20 (SPY)";
  }
}
if (inputTicker) inputTicker.addEventListener("input", () => { if (compraTipo === "cedear") autofillRatio(); });

function setTipo(t) {
  tipoActivo = t;
  tabs.forEach(tab => tab.classList.toggle("active", tab.dataset.tipo === t));
  const isCompra = t === "compra";
  if (fieldsDefault) fieldsDefault.classList.toggle("hidden", isCompra);
  if (fieldsCompra) fieldsCompra.classList.toggle("hidden", !isCompra);
  if (isCompra) setCompraTipo(compraTipo);
  if (isCompra && inputFecha && !inputFecha.value) inputFecha.value = hoyISO();
  if (!isCompra && inputFechaMov && !inputFechaMov.value) inputFechaMov.value = hoyISO();
}
tabs.forEach(tab => tab.addEventListener("click", () => setTipo(tab.dataset.tipo)));

function updateCompraPreview() {
  const cant = Number(inputCantidad.value);
  const precio = Number(inputPrecio.value);
  const preview = $("preview-total");
  if (!cant || !precio) { preview.textContent = ""; return; }
  const total = cant * precio;
  if (compraTipo === "accion_us") {
    preview.textContent = `Total USD ${total.toLocaleString("es-AR", { maximumFractionDigits: 2 })} (no sale del saldo en $)`;
  } else {
    preview.textContent = `Total ${fmt(total)} (sale del saldo)`;
  }
}
if (inputCantidad) inputCantidad.addEventListener("input", updateCompraPreview);
if (inputPrecio) inputPrecio.addEventListener("input", updateCompraPreview);

// Sugerencia automática del precio de compra: al tener ticker + fecha, busca en
// Yahoo el precio de ese día (CEDEAR en ARS, acción EEUU en USD, dólar = tipo de
// cambio) y lo autocompleta si el usuario todavía no cargó un precio a mano.
let precioSugeridoToken = 0;
let precioAutocompletado = false; // true si el valor actual lo puso la sugerencia
async function sugerirPrecioCompra() {
  const hint = $("precio-hint");
  if (!hint) return;
  const tipo = compraTipo;
  const ticker = tipo === "usd" ? "USD" : inputTicker.value.trim().toUpperCase();
  const fechaStr = inputFecha.value;
  if ((tipo !== "usd" && !ticker) || !fechaStr) { hint.textContent = ""; return; }
  // Respeta un precio cargado a mano (no lo pisa).
  if (inputPrecio.value && Number(inputPrecio.value) > 0 && !precioAutocompletado) return;

  const token = ++precioSugeridoToken;
  hint.textContent = "Buscando precio sugerido…";
  const precio = await fetchPrecioHistorico(ticker, fechaStr, tipo);
  if (token !== precioSugeridoToken) return; // llegó otra búsqueda más nueva
  if (precio == null) {
    hint.textContent = "Sin precio sugerido para esa fecha — cargalo a mano.";
    return;
  }
  // Sólo autocompleta si el campo sigue vacío o lo había puesto la sugerencia.
  if (!inputPrecio.value || Number(inputPrecio.value) <= 0 || precioAutocompletado) {
    inputPrecio.value = tipo === "accion_us" ? Number(precio.toFixed(2)) : Math.round(precio);
    precioAutocompletado = true;
    updateCompraPreview();
  }
  const unidad = tipo === "accion_us" ? `USD ${precio.toFixed(2)}` : fmt(precio);
  const etiqueta = tipo === "usd" ? "Tipo de cambio sugerido" : "Precio sugerido";
  hint.textContent = `${etiqueta} (Yahoo) para ${fechaStr}: ${unidad} — editá si no coincide.`;
}
if (inputTicker) inputTicker.addEventListener("change", sugerirPrecioCompra);
if (inputFecha) inputFecha.addEventListener("change", sugerirPrecioCompra);
// Si el usuario escribe el precio a mano, deja de considerarse autocompletado.
if (inputPrecio) inputPrecio.addEventListener("input", () => { precioAutocompletado = false; });

$("form-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    if (tipoActivo === "compra") {
      await handleCompraSubmit();
    } else {
      const monto = Number(inputValor.value);
      if (!monto || monto <= 0) { alert("Monto inválido"); return; }
      const fechaStr = inputFechaMov.value || hoyISO();
      if (!fechaStr) { alert("Falta la fecha"); return; }
      const desc = inputDesc.value.trim() || tipoActivo;
      const fechaIso = `${fechaStr} 12:00:00-03:00`;
      const created = await sbInsert({
        fecha: fechaIso,
        tipo: tipoActivo,
        horas: null,
        monto,
        desc,
      });
      const cache = getCache();
      cache.unshift(created);
      setCache(cache);
      render();
      inputValor.value = "";
      inputDesc.value = "";
      inputFechaMov.value = hoyISO();
    }
  } catch (err) {
    alert("No se pudo guardar: " + err.message);
  } finally {
    btn.disabled = false;
  }
});

// Dolar MEP del día (o el más cercano hacia atrás si es feriado/finde)
async function fetchMepForDate(fechaStr) {
  const base = new Date(fechaStr + "T12:00:00-03:00");
  for (let offset = 0; offset < 5; offset++) {
    const d = new Date(base);
    d.setDate(d.getDate() - offset);
    const iso = d.toISOString().slice(0, 10);
    try {
      const res = await fetch(`https://api.argentinadatos.com/v1/cotizaciones/dolares/bolsa/${iso}`);
      if (res.ok) {
        const data = await res.json();
        const venta = Number(data?.venta);
        if (venta > 0) return venta;
      }
    } catch {}
  }
  return null;
}

// tipo: "cedear" (precio ARS en BYMA, símbolo .BA), "accion_us" (precio USD, símbolo plano),
// "usd" (tipo de cambio ARS/USD).
// Símbolo de Yahoo según el tipo de activo:
//  - cedear    -> "<TICKER>.BA" (CEDEAR en BYMA, precio en ARS)
//  - accion_us -> "<TICKER>"    (acción en EEUU / subyacente, precio en USD)
//  - usd       -> "ARS=X"       (tipo de cambio ARS por USD)
function symbolDe(ticker, tipo) {
  if (tipo === "usd" || ticker === "USD") return "ARS=X";
  return tipo === "accion_us" ? ticker : `${ticker}.BA`;
}

// GET a Yahoo Finance con fallback por proxy CORS si el request directo falla.
async function yahooFetch(url) {
  async function tryFetch(u) {
    const res = await fetch(u);
    if (!res.ok) throw new Error(res.status);
    return res.json();
  }
  try {
    return await tryFetch(url);
  } catch {
    try {
      return await tryFetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`);
    } catch {
      return null;
    }
  }
}

async function fetchPrecioHistorico(ticker, fechaStr, tipo = "cedear") {
  const symbol = symbolDe(ticker, tipo);
  const fecha = new Date(fechaStr + "T12:00:00-03:00").getTime() / 1000;
  const start = Math.floor(fecha - 86400 * 5);
  const end = Math.floor(fecha + 86400 * 2);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${start}&period2=${end}&interval=1d`;
  const data = await yahooFetch(url);

  const result = data?.chart?.result?.[0];
  if (!result) return null;
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  let best = null, bestDiff = Infinity;
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    const diff = Math.abs(timestamps[i] - fecha);
    if (diff < bestDiff) { bestDiff = diff; best = closes[i]; }
  }
  return best;
}

// Precio actual del subyacente en USD (símbolo plano en el mercado de EEUU).
// Sirve tanto para CEDEARs (valor de la acción real) como para acciones de EEUU.
async function fetchPrecioActualUsd(ticker) {
  if (!ticker || ticker === "USD") return null;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`;
  const data = await yahooFetch(url);
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  if (meta?.regularMarketPrice != null) return Number(meta.regularMarketPrice);
  // Fallback: último cierre disponible.
  const closes = result?.indicators?.quote?.[0]?.close || [];
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] != null) return Number(closes[i]);
  }
  return null;
}

// Refresca en vivo el precio actual (USD) de todos los tickers de la cartera.
async function fetchPreciosActualesLive(tickers) {
  const uniq = [...new Set(tickers.filter(t => t && t !== "USD"))];
  const pares = await Promise.all(uniq.map(async t => [t, await fetchPrecioActualUsd(t)]));
  for (const [t, precio] of pares) {
    if (precio != null) {
      preciosActualesCache[t] = { ...(preciosActualesCache[t] || {}), ticker: t, precio_usd: precio, live: true };
    }
  }
  preciosActualizados = new Date();
}

async function handleCompraSubmit() {
  const tipo = compraTipo; // "cedear" | "accion_us" | "usd"
  const ticker = tipo === "usd" ? "USD" : inputTicker.value.trim().toUpperCase();
  const cantidad = Number(inputCantidad.value);
  let precio = Number(inputPrecio.value);
  const fechaStr = inputFecha.value || hoyISO();
  if (tipo !== "usd" && !ticker) { alert("Falta el ticker"); return; }
  if (!cantidad || cantidad <= 0) { alert("Cantidad inválida"); return; }
  if (!fechaStr) { alert("Falta la fecha"); return; }

  // Ratio: sólo para CEDEARs. Se pregunta si es un ticker nuevo.
  let ratio = null;
  if (tipo === "cedear") {
    ratio = Number(inputRatio.value) || ratioConocido(ticker);
    if (!ratio || ratio <= 0) {
      const rStr = prompt(`¿Cuántos CEDEARs equivalen a 1 acción real de ${ticker}? (ej. 20)`);
      if (rStr === null) return;
      ratio = Number(rStr);
      if (!ratio || ratio <= 0) { alert("Ratio inválido"); return; }
    }
    setRatio(ticker, ratio);
  }

  // Si falta el precio, buscarlo (ARS para CEDEAR/USD, USD para acción de EEUU).
  if (!precio || precio <= 0) {
    const btn = document.querySelector("#form-add button[type=submit]");
    if (btn) btn.textContent = "Buscando precio...";
    const lookup = await fetchPrecioHistorico(ticker, fechaStr, tipo);
    if (btn) btn.textContent = "Agregar";
    if (!lookup) { alert(`No pude obtener el precio de ${ticker} para ${fechaStr}. Ingresalo a mano.`); return; }
    precio = lookup;
    const unidad = tipo === "accion_us" ? `USD ${precio.toFixed(2)}` : fmt(precio);
    if (!confirm(`Precio encontrado para ${ticker} el ${fechaStr}: ${unidad}/u. ¿Usar este?`)) return;
  }

  const total = cantidad * precio;
  const fechaIso = `${fechaStr} 12:00:00-03:00`;

  // Confirmación + payload según el tipo.
  let inv, egresoMonto = null;
  if (tipo === "accion_us") {
    // Acción de EEUU: precio en USD, no lleva ratio ni sale del saldo en pesos.
    if (!confirm(`Comprar ${cantidad} ${ticker} (acción EEUU) a USD ${precio.toFixed(2)}/u = USD ${total.toFixed(2)}. No se descuenta del saldo en $. ¿Confirmar?`)) return;
    inv = {
      ticker, tipo_activo: "accion_us", cantidad,
      precio_ars: null, precio_usd: precio, mep: null,
      fecha: fechaIso, notas: "compra desde app",
    };
  } else if (tipo === "usd") {
    // Dólar cash: precio = tipo de cambio ARS/USD. Sale del saldo en pesos.
    if (!confirm(`Comprar ${cantidad} USD a ${fmt(precio)}/USD = ${fmt(total)} (se descuenta del saldo). ¿Confirmar?`)) return;
    inv = {
      ticker: "USD", tipo_activo: "usd", cantidad,
      precio_ars: precio, precio_usd: 1, mep: precio,
      fecha: fechaIso, notas: "compra desde app",
    };
    egresoMonto = total;
  } else {
    // CEDEAR: precio en ARS. Sale del saldo. Se dolariza al MEP del día.
    if (!confirm(`Comprar ${cantidad} ${ticker} (CEDEAR ${ratio}:1) a ${fmt(precio)}/u = ${fmt(total)} (se descuenta del saldo). ¿Confirmar?`)) return;
    const mep = await fetchMepForDate(fechaStr);
    inv = {
      ticker, tipo_activo: "cedear", cantidad,
      precio_ars: precio, precio_usd: null, mep,
      fecha: fechaIso, notas: "compra desde app",
    };
    egresoMonto = total;
  }

  await sbInsertInversion(inv);

  if (egresoMonto !== null) {
    const egreso = await sbInsert({
      fecha: new Date().toISOString(),
      tipo: "egreso",
      horas: null,
      monto: egresoMonto,
      desc: `Compra ${cantidad} ${ticker}`,
    });
    const cache = getCache();
    cache.unshift(egreso);
    setCache(cache);
    render();
  }

  inputTicker.value = "";
  inputCantidad.value = "";
  inputPrecio.value = "";
  if (inputRatio) inputRatio.value = "";
  inputFecha.value = hoyISO();
  $("preview-total").textContent = "";
  precioAutocompletado = false;
  if ($("precio-hint")) $("precio-hint").textContent = "";
}

async function agregarHoras(horas, desc) {
  try {
    const created = await sbInsert({
      fecha: new Date().toISOString(),
      tipo: "horas",
      horas,
      monto: horas * getValorHora(),
      desc,
    });
    const cache = getCache();
    cache.unshift(created);
    setCache(cache);
    render();
  } catch (e) {
    alert("No se pudo guardar: " + e.message);
  }
}

// ==== Render ====
function calcSaldo(movs) {
  return movs.reduce((s, m) => s + (m.tipo === "egreso" ? -m.monto : m.monto), 0);
}

function render() {
  const movs = getCache();
  const saldo = calcSaldo(movs);
  const saldoEl = $("saldo");
  saldoEl.textContent = fmt(saldo);
  saldoEl.classList.toggle("negativo", saldo < 0);

  $("valor-hora-label").textContent = fmt(getValorHora());
  $("check-time-label").textContent = getCheckTime();

  const ul = $("lista");
  ul.innerHTML = "";
  if (!movs.length) {
    ul.innerHTML = '<li style="justify-content:center;color:var(--muted)">Sin movimientos todavía</li>';
    return;
  }
  for (const m of movs) {
    const li = document.createElement("li");
    const signo = m.tipo === "egreso" ? "-" : "+";
    const cls = m.tipo === "egreso" ? "neg" : "pos";
    const fecha = new Date(m.fecha).toLocaleDateString("es-AR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    const extra = m.tipo === "horas" ? ` · ${m.horas}hs` : "";
    li.innerHTML = `
      <div class="mov-info">
        <div class="mov-desc">${escapeHtml(m.desc)}</div>
        <div class="mov-meta">${fecha} · ${m.tipo}${extra}</div>
      </div>
      <div class="mov-monto ${cls}">${signo}${fmt(m.monto)}</div>
      <button class="mov-delete" data-id="${m.id}" aria-label="Borrar">✕</button>
    `;
    ul.appendChild(li);
  }
  ul.querySelectorAll(".mov-delete").forEach(b => {
    b.addEventListener("click", async () => {
      if (!confirm("¿Borrar este movimiento?")) return;
      const id = Number(b.dataset.id);
      try {
        await sbDelete(id);
        setCache(getCache().filter(m => m.id !== id));
        render();
      } catch (e) {
        alert("No se pudo borrar: " + e.message);
      }
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ==== Banner control diario ====
function pasoHoraControl() {
  const [hh, mm] = getCheckTime().split(":").map(Number);
  const now = new Date();
  const threshold = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0);
  return now >= threshold;
}

async function checkConfirmBanner() {
  const banner = $("banner-confirm");
  const text = $("banner-text");
  const now = new Date();

  // Banner solo aparece en días hábiles después de la hora de control
  if (!isWeekday(now) || !pasoHoraControl()) {
    banner.classList.add("hidden");
    return;
  }

  const pending = await pendingWeekdays();
  if (pending.length === 0) {
    banner.classList.add("hidden");
    return;
  }

  if (pending.length === 1) {
    text.textContent = "¿Trabajaste hoy 9 a 18hs?";
  } else {
    const dates = pending.map(fmtDiaMes).join(", ");
    text.textContent = `${pending.length} jornadas pendientes: ${dates}`;
  }
  banner.classList.remove("hidden");
}

let bannerInterval = null;
function startBannerPolling() {
  stopBannerPolling();
  bannerInterval = setInterval(checkConfirmBanner, 30000);
}
function stopBannerPolling() {
  if (bannerInterval) { clearInterval(bannerInterval); bannerInterval = null; }
}
document.addEventListener("visibilitychange", async () => {
  if (!document.hidden && !appScreen.classList.contains("hidden")) {
    await syncFromSupabase();
    checkConfirmBanner();
  }
});

function promptHorasCustom() {
  const txt = prompt("¿Cuántas horas trabajaste hoy?", "9");
  if (!txt) return;
  const h = Number(txt);
  if (!h || h <= 0) { alert("Valor inválido"); return; }
  const desc = prompt("Descripción (opcional):", `Jornada ${hoyLabel()}`) || `Jornada ${hoyLabel()}`;
  agregarHoras(h, desc);
  $("banner-confirm").classList.add("hidden");
}

$("btn-confirm-si").addEventListener("click", async () => {
  $("btn-confirm-si").disabled = true;
  try {
    const { count } = await confirmarPendientesBatch();
    if (count > 0) {
      await syncFromSupabase();
      $("banner-confirm").classList.add("hidden");
    } else {
      alert("No hay jornadas pendientes");
    }
  } catch (e) {
    alert("Error: " + e.message);
  } finally {
    $("btn-confirm-si").disabled = false;
  }
});
$("btn-confirm-editar").addEventListener("click", promptHorasCustom);

// ==== Config ====
$("btn-config").addEventListener("click", () => {
  const nuevaHora = prompt("Horario del control diario (HH:MM):", getCheckTime());
  if (nuevaHora !== null && /^\d{1,2}:\d{2}$/.test(nuevaHora.trim())) {
    const [h, m] = nuevaHora.trim().split(":").map(Number);
    if (h >= 0 && h < 24 && m >= 0 && m < 60) {
      setCheckTime(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  render();
  checkConfirmBanner();
});

// ==== Export ====
$("btn-export").addEventListener("click", () => {
  const movs = getCache();
  const rows = [["fecha", "tipo", "horas", "monto", "descripcion"]];
  for (const m of movs) rows.push([m.fecha, m.tipo, m.horas || "", m.monto, m.desc]);
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `sueldo-${hoyISO()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ==== Inversiones ====
const invScreen = $("inversiones-screen");
const tdScreen = $("ticker-detail-screen");
let inversionesCache = [];
let preciosActualesCache = {}; // {ticker: {precio_ars, precio_usd}}
let preciosActualizados = null; // Date del último refresco de precios en vivo
let currentDetailTicker = null;

// Ratio CEDEAR:subyacente (ej SPY: 20 CEDEARs = 1 SPY real)
// precio_usd almacenado y de Yahoo es del subyacente, hay que dividir para convertir a unidades del usuario.
// Los ratios conocidos vienen precargados; los que el usuario ingresa se guardan en localStorage
// (por ticker), así no vuelve a preguntar por un CEDEAR que ya cargó antes.
const RATIOS_SEED = {
  SPY: 20, BRKB: 22, XLF: 2, XLE: 2, GGAL: 10,
  CEPU: 10, PAMPX: 25, YPF: 1, AAPL: 10, KO: 10, AMZN: 20, MSFT: 20,
};
const KEY_RATIOS = "sueldo.ratios";
function getRatiosStore() {
  try { return JSON.parse(localStorage.getItem(KEY_RATIOS) || "{}"); } catch { return {}; }
}
function getRatios() {
  return { ...RATIOS_SEED, ...getRatiosStore() };
}
// Ratio conocido para un ticker, o null si nunca se cargó.
function ratioConocido(ticker) {
  const r = Number(getRatios()[ticker]);
  return r > 0 ? r : null;
}
function setRatio(ticker, ratio) {
  const store = getRatiosStore();
  store[ticker] = ratio;
  localStorage.setItem(KEY_RATIOS, JSON.stringify(store));
}
// Ratio efectivo para el cálculo: 1 salvo que sea un CEDEAR con ratio conocido.
const ratioDe = (t) => ratioConocido(t) || 1;

async function sbFetchInversiones() {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/inversiones?select=*&order=fecha.desc`, { headers: sbHeaders });
    if (!res.ok) throw new Error(res.status);
    inversionesCache = await res.json();
    return inversionesCache;
  } catch (e) {
    console.warn("fetch inversiones:", e);
    return [];
  }
}

async function sbFetchPreciosActuales() {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/precios_actuales?select=*`, { headers: sbHeaders });
    if (!res.ok) throw new Error(res.status);
    const rows = await res.json();
    preciosActualesCache = {};
    for (const r of rows) preciosActualesCache[r.ticker] = r;
    return preciosActualesCache;
  } catch (e) {
    console.warn("fetch precios:", e);
    return {};
  }
}

async function sbInsertInversion(inv) {
  const res = await fetch(`${SB_URL}/rest/v1/inversiones`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "return=representation" },
    body: JSON.stringify(inv),
  });
  if (!res.ok) throw new Error(`insert ${res.status}: ${await res.text()}`);
  const [row] = await res.json();
  return row;
}

async function sbDeleteInversion(id) {
  const res = await fetch(`${SB_URL}/rest/v1/inversiones?id=eq.${id}`, {
    method: "DELETE",
    headers: sbHeaders,
  });
  if (!res.ok) throw new Error(`delete ${res.status}`);
}

// Normaliza el tipo (compat: filas viejas sin tipo asumen cedear salvo ticker USD).
function tipoDe(r) {
  if (r.tipo_activo === "usd" || r.tipo_activo === "accion_us" || r.tipo_activo === "cedear") return r.tipo_activo;
  return r.ticker === "USD" ? "usd" : "cedear";
}

// Agrega los lotes en posiciones (por ticker + tipo) y calcula el costo invertido en USD.
// - CEDEAR: costo USD = ARS pagado / MEP del día. El valor de mercado usa el ratio.
// - Acción EEUU: costo USD = cantidad × precio USD. Ratio 1.
// - USD cash: el costo (y el valor) en USD es la cantidad de dólares.
function aggregatePositions(rows) {
  const map = new Map();
  for (const r of rows) {
    const tipo = tipoDe(r);
    const ratio = tipo === "cedear" ? ratioDe(r.ticker) : 1;
    const key = `${r.ticker}|${tipo}`;
    const cant = Number(r.cantidad);
    const pArs = r.precio_ars != null ? Number(r.precio_ars) : null;
    const pUsd = r.precio_usd != null ? Number(r.precio_usd) : null;
    const mep = r.mep != null ? Number(r.mep) : null;

    if (!map.has(key)) {
      map.set(key, {
        ticker: r.ticker, tipo_activo: tipo, ratio,
        cantidad: 0, invertidoUsd: 0, invertidoArs: 0,
        cantConDato: 0, // unidades (CEDEARs/acciones) con costo USD conocido
      });
    }
    const p = map.get(key);
    p.cantidad += cant;
    if (cant <= 0) continue; // ventas no suman al costo

    if (tipo === "usd") {
      p.invertidoUsd += cant;                       // dólares
      if (pArs !== null) p.invertidoArs += cant * pArs;
      p.cantConDato += cant;
    } else if (tipo === "accion_us") {
      if (pUsd !== null) { p.invertidoUsd += cant * pUsd; p.cantConDato += cant; }
    } else { // cedear
      if (pArs !== null) p.invertidoArs += cant * pArs;
      if (pArs !== null && mep) {
        p.invertidoUsd += (cant * pArs) / mep;      // dolarizado al MEP
        p.cantConDato += cant;
      } else if (pUsd !== null) {
        // Compat: lotes viejos con precio_usd del subyacente.
        p.invertidoUsd += (cant / ratio) * pUsd;
        p.cantConDato += cant;
      }
    }
  }
  return [...map.values()].map(p => {
    // Precio USD promedio por acción/subyacente (para el % de variación).
    let promUsd = null;
    if (p.cantConDato > 0 && p.invertidoUsd > 0) {
      const unidadesSubyacente = p.tipo_activo === "cedear" ? p.cantConDato / p.ratio : p.cantConDato;
      if (unidadesSubyacente > 0) promUsd = p.invertidoUsd / unidadesSubyacente;
    }
    return { ...p, promUsd };
  });
}

async function openInversiones() {
  appScreen.classList.add("hidden");
  invScreen.classList.remove("hidden");
  invScreen.scrollTop = 0;
  // Render rápido con lo que haya en cache (Supabase), después actualiza en vivo.
  await Promise.all([sbFetchInversiones(), sbFetchPreciosActuales()]);
  renderInversiones();
  await refreshPreciosLive();
}

// Recalcula online el valor actual contra Yahoo Finance (API pública).
async function refreshPreciosLive() {
  const btn = $("btn-inv-refresh");
  if (btn) { btn.disabled = true; btn.classList.add("spin"); }
  try {
    const tickers = [...new Set(inversionesCache.map(r => r.ticker))];
    await fetchPreciosActualesLive(tickers);
    renderInversiones();
  } catch (e) {
    console.warn("precios en vivo:", e);
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove("spin"); }
  }
}

function closeInversiones() {
  invScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
}

function renderInversiones() {
  const positions = aggregatePositions(inversionesCache).filter(p => Math.abs(p.cantidad) > 0.0001);
  let totalUsd = 0;        // valor de mercado hoy
  let totalInvertidoUsd = 0; // costo (lo que puse)

  // Render positions
  const ul = $("inv-positions");
  ul.innerHTML = "";
  if (!positions.length) {
    ul.innerHTML = '<li style="justify-content:center;color:var(--muted)">Sin posiciones</li>';
  } else {
    // Orden: CEDEARs y acciones primero, USD al final
    positions.sort((a, b) => (a.tipo_activo === "usd") - (b.tipo_activo === "usd") || a.ticker.localeCompare(b.ticker));
    for (const p of positions) {
      const curr = preciosActualesCache[p.ticker];
      const currUsd = curr?.precio_usd ? Number(curr.precio_usd) : null;
      const ratio = p.ratio || 1;

      // Costo invertido en USD proporcional a lo que queda en cartera.
      // (invertidoUsd es sobre las unidades con dato; si vendiste parte, prorrateo.)
      let invertidoUsd = p.invertidoUsd;
      if (p.tipo_activo !== "usd" && p.cantConDato > 0 && p.cantidad < p.cantConDato) {
        invertidoUsd = p.invertidoUsd * (p.cantidad / p.cantConDato);
      }
      totalInvertidoUsd += invertidoUsd;

      // Valor actual estimado en USD (aplicando ratio CEDEAR → subyacente).
      let valorUsd = null;
      if (p.tipo_activo === "usd") {
        valorUsd = p.cantidad; // 1 USD = 1 USD
      } else if (currUsd !== null) {
        valorUsd = (p.cantidad / ratio) * currUsd;
      } else {
        valorUsd = invertidoUsd; // sin precio actual: se muestra a costo
      }
      if (valorUsd !== null) totalUsd += valorUsd;

      // P/L %: valor hoy vs costo invertido.
      let pl = null;
      if (p.tipo_activo !== "usd" && invertidoUsd > 0 && valorUsd !== null && currUsd !== null) {
        pl = ((valorUsd - invertidoUsd) / invertidoUsd) * 100;
      }

      const li = document.createElement("li");
      const tipoLabel = p.tipo_activo === "usd" ? "USD cash"
        : p.tipo_activo === "accion_us" ? `${p.ticker} · acción EEUU`
        : p.ticker;
      const ratioLabel = p.tipo_activo === "cedear" && ratio > 1 ? ` (${ratio}:1)` : "";
      const cantLabel = p.tipo_activo === "usd"
        ? `${Math.round(p.cantidad).toLocaleString("es-AR")} USD`
        : `${p.cantidad} unid`;
      const valorLabel = valorUsd !== null ? `USD ${Math.round(valorUsd).toLocaleString("es-AR")}` : "—";
      const plLabel = pl !== null ? ` ${pl >= 0 ? "+" : ""}${pl.toFixed(1)}%` : "";
      const invLabel = p.tipo_activo !== "usd" && invertidoUsd > 0
        ? `invertido USD ${Math.round(invertidoUsd).toLocaleString("es-AR")}` : "";
      const currSubyacente = currUsd !== null && p.tipo_activo !== "usd" ? `hoy USD ${currUsd.toFixed(2)}/u` : "";
      li.style.cursor = "pointer";
      li.dataset.ticker = p.ticker;
      li.innerHTML = `
        <div class="mov-info">
          <div class="mov-desc"><strong>${tipoLabel}</strong>${ratioLabel} · ${cantLabel} <span style="color:var(--muted);font-weight:400">›</span></div>
          <div class="mov-meta">${invLabel}${invLabel && currSubyacente ? " · " : ""}${currSubyacente}</div>
        </div>
        <div class="mov-monto ${pl !== null && pl < 0 ? "neg" : "pos"}">${valorLabel}<br><small>${plLabel || ""}</small></div>
      `;
      li.addEventListener("click", () => openTickerDetail(p.ticker));
      ul.appendChild(li);
    }
  }

  $("inv-total").textContent = `USD ${Math.round(totalUsd).toLocaleString("es-AR")}`;
  const plTotal = totalInvertidoUsd > 0 ? ((totalUsd - totalInvertidoUsd) / totalInvertidoUsd) * 100 : null;
  const plTxt = plTotal !== null ? ` · ${plTotal >= 0 ? "+" : ""}${plTotal.toFixed(1)}%` : "";
  $("inv-invertido").textContent = `Invertido USD ${Math.round(totalInvertidoUsd).toLocaleString("es-AR")}${plTxt}`;
  const updatedEl = $("inv-updated");
  if (updatedEl) {
    updatedEl.textContent = preciosActualizados
      ? `↻ en vivo · ${preciosActualizados.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`
      : "";
  }

  // Render transactions
  const txUl = $("inv-transactions");
  txUl.innerHTML = "";
  const recientes = inversionesCache.slice(0, 30);
  if (!recientes.length) {
    txUl.innerHTML = '<li style="justify-content:center;color:var(--muted)">Sin transacciones</li>';
  } else {
    for (const r of recientes) {
      const cant = Number(r.cantidad);
      const signo = cant >= 0 ? "+" : "";
      const fecha = new Date(r.fecha).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "2-digit" });
      const precio = r.precio_ars ? `$${Math.round(Number(r.precio_ars)).toLocaleString("es-AR")}` : (r.precio_usd ? `USD ${r.precio_usd}` : "—");
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="mov-info">
          <div class="mov-desc">${r.ticker} ${signo}${cant}</div>
          <div class="mov-meta">${fecha} · ${precio} ${r.notas ? "· " + escapeHtml(r.notas) : ""}</div>
        </div>
        <button class="mov-delete" data-id="${r.id}" aria-label="Borrar">✕</button>
      `;
      txUl.appendChild(li);
    }
    txUl.querySelectorAll(".mov-delete").forEach(b => {
      b.addEventListener("click", async () => {
        if (!confirm("¿Borrar esta transacción?")) return;
        try {
          await sbDeleteInversion(Number(b.dataset.id));
          inversionesCache = inversionesCache.filter(x => x.id !== Number(b.dataset.id));
          renderInversiones();
        } catch (e) { alert("Error: " + e.message); }
      });
    });
  }
}

async function agregarInversion() {
  const tipoStr = prompt("Tipo: 1 = CEDEAR, 2 = Acción EEUU (USD), 3 = Dólar cash", "1");
  if (tipoStr === null) return;
  const tipo = tipoStr.trim() === "3" ? "usd" : tipoStr.trim() === "2" ? "accion_us" : "cedear";

  let tickerUp = "USD";
  if (tipo !== "usd") {
    const ticker = prompt("Ticker (ej SPY, BRKB, AAPL):");
    if (!ticker) return;
    tickerUp = ticker.trim().toUpperCase();
  }

  const cantStr = prompt("Cantidad (positivo = compra, negativo = venta):");
  if (!cantStr) return;
  const cantidad = Number(cantStr);
  if (!cantidad) { alert("Cantidad inválida"); return; }

  // Ratio para CEDEARs nuevos.
  let ratio = null;
  if (tipo === "cedear" && cantidad > 0) {
    ratio = ratioConocido(tickerUp);
    if (!ratio) {
      const rStr = prompt(`¿Cuántos CEDEARs equivalen a 1 acción real de ${tickerUp}? (ej. 20)`);
      if (rStr === null) return;
      ratio = Number(rStr);
      if (!ratio || ratio <= 0) { alert("Ratio inválido"); return; }
    }
    setRatio(tickerUp, ratio);
  }

  let precio_ars = null, precio_usd = null, mep = null;
  const fechaStr = prompt("Fecha (YYYY-MM-DD), vacío = hoy:", hoyISO());
  const fechaDia = fechaStr && fechaStr.trim() ? fechaStr.trim() : hoyISO();

  if (tipo === "accion_us") {
    const pUsdStr = prompt("Precio por unidad en USD:");
    precio_usd = pUsdStr ? Number(pUsdStr) : null;
  } else if (tipo === "usd") {
    const pArsStr = prompt("Tipo de cambio (ARS por USD):");
    precio_ars = pArsStr ? Number(pArsStr) : null;
    precio_usd = 1;
    mep = precio_ars;
  } else { // cedear
    const pArsStr = prompt("Precio por unidad en ARS:");
    precio_ars = pArsStr ? Number(pArsStr) : null;
    if (cantidad > 0 && precio_ars) mep = await fetchMepForDate(fechaDia);
  }

  const fecha = `${fechaDia} 12:00:00-03:00`;
  const notas = prompt("Notas (opcional):", "") || null;
  try {
    await sbInsertInversion({ ticker: tickerUp, tipo_activo: tipo, cantidad, precio_ars, precio_usd, mep, fecha, notas });
    await sbFetchInversiones();
    renderInversiones();
  } catch (e) {
    alert("Error: " + e.message);
  }
}

async function sbPatchInversion(id, fields) {
  const res = await fetch(`${SB_URL}/rest/v1/inversiones?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...sbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`patch ${res.status}`);
}

async function backfillPrecios() {
  const pendientes = inversionesCache.filter(r => {
    const p = Number(r.precio_ars);
    const m = Number(r.mep);
    return (!p || p <= 0) || (!m || m <= 0);
  });
  if (!pendientes.length) { alert("Todas las transacciones ya tienen precio y MEP."); return; }
  if (!confirm(`Completar precio/MEP para ${pendientes.length} transacción(es)?`)) return;

  const btn = $("btn-inv-backfill");
  btn.disabled = true;
  const origLbl = btn.textContent;

  let ok = 0, fail = 0;
  for (let i = 0; i < pendientes.length; i++) {
    const r = pendientes[i];
    btn.textContent = `${i + 1}/${pendientes.length}...`;
    const fechaStr = new Date(r.fecha).toISOString().slice(0, 10);
    const patch = {};
    try {
      if (!Number(r.precio_ars)) {
        const precio = await fetchPrecioHistorico(r.ticker, fechaStr);
        if (precio && precio > 0) patch.precio_ars = precio;
      }
      if (!Number(r.mep)) {
        const mep = await fetchMepForDate(fechaStr);
        if (mep && mep > 0) patch.mep = mep;
      }
      if (Object.keys(patch).length > 0) {
        await sbPatchInversion(r.id, patch);
        ok++;
      } else {
        fail++;
      }
    } catch (e) {
      fail++;
    }
  }

  btn.textContent = origLbl;
  btn.disabled = false;
  alert(`Completado: ${ok} actualizadas, ${fail} sin datos.`);
  await sbFetchInversiones();
  renderInversiones();
}

// --- Ticker detail screen ---
async function openTickerDetail(ticker) {
  currentDetailTicker = ticker;
  invScreen.classList.add("hidden");
  tdScreen.classList.remove("hidden");
  tdScreen.scrollTop = 0;
  await sbFetchInversiones();
  renderTickerDetail();
}

function closeTickerDetail() {
  tdScreen.classList.add("hidden");
  invScreen.classList.remove("hidden");
  renderInversiones();
}

function renderTickerDetail() {
  const ticker = currentDetailTicker;
  if (!ticker) return;
  const items = inversionesCache.filter(r => r.ticker === ticker);
  items.sort((a, b) => b.fecha.localeCompare(a.fecha));

  $("td-ticker").textContent = ticker;

  // Stats
  const tipo = tipoDe(items[0] || {});
  const tipoTxt = tipo === "usd" ? "Dólar cash" : tipo === "accion_us" ? "Acción EEUU" : "CEDEAR";
  const totalCant = items.reduce((s, r) => s + Number(r.cantidad), 0);
  const compras = items.filter(r => Number(r.cantidad) > 0);
  const costoArsTotal = compras.reduce((s, r) => s + (r.precio_ars ? Number(r.cantidad) * Number(r.precio_ars) : 0), 0);
  const usdMepTotal = compras.reduce((s, r) => {
    if (r.precio_ars && r.mep) return s + (Number(r.cantidad) * Number(r.precio_ars) / Number(r.mep));
    return s;
  }, 0);
  // Costo en USD para acciones de EEUU (precio en dólares directo).
  const usdDirectoTotal = compras.reduce((s, r) => s + (r.precio_usd ? Number(r.cantidad) * Number(r.precio_usd) : 0), 0);
  const cantConArs = compras.filter(r => r.precio_ars).reduce((s, r) => s + Number(r.cantidad), 0);
  const promArs = cantConArs > 0 ? costoArsTotal / cantConArs : 0;

  const stats = [];
  stats.push(tipoTxt);
  if (tipo === "cedear") { const rat = ratioDe(ticker); if (rat > 1) stats.push(`${rat}:1`); }
  stats.push(`${totalCant} unid`);
  if (promArs) stats.push(`CPC ${fmt(promArs)}`);
  if (costoArsTotal) stats.push(`${fmt(costoArsTotal)}`);
  if (usdMepTotal) stats.push(`USD ${Math.round(usdMepTotal).toLocaleString("es-AR")} @ MEP`);
  if (tipo === "accion_us" && usdDirectoTotal) stats.push(`USD ${usdDirectoTotal.toFixed(2)} invertido`);
  $("td-stats").textContent = stats.join(" · ");

  const ul = $("td-list");
  ul.innerHTML = "";
  if (!items.length) {
    ul.innerHTML = '<li style="justify-content:center;color:var(--muted)">Sin lotes</li>';
    return;
  }
  for (const r of items) {
    const cant = Number(r.cantidad);
    const rtipo = tipoDe(r);
    const fecha = new Date(r.fecha).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
    // Acción EEUU: precio en USD. CEDEAR / dólar: precio en ARS.
    const precioArs = rtipo === "accion_us"
      ? (r.precio_usd ? `USD ${Number(r.precio_usd).toFixed(2)}` : "sin precio USD")
      : (r.precio_ars ? fmt(Number(r.precio_ars)) : "sin precio ARS");
    const total = rtipo === "accion_us"
      ? (r.precio_usd ? `USD ${(Math.abs(cant) * Number(r.precio_usd)).toFixed(2)}` : "")
      : (r.precio_ars ? fmt(Math.abs(cant) * Number(r.precio_ars)) : "");
    const usdMep = rtipo !== "accion_us" && r.precio_ars && r.mep
      ? `USD ${(Math.abs(cant) * Number(r.precio_ars) / Number(r.mep)).toFixed(2)} @ MEP ${Math.round(Number(r.mep))}`
      : "";
    const signo = cant >= 0 ? "+" : "";
    const signClass = cant < 0 ? "neg" : "pos";
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="mov-info">
        <div class="mov-desc"><span class="${signClass}"><strong>${signo}${cant}</strong></span> @ ${precioArs}</div>
        <div class="mov-meta">${fecha}${total ? ' · ' + total : ''}${usdMep ? ' · ' + usdMep : ''}${r.notas ? ' · ' + escapeHtml(r.notas) : ''}</div>
      </div>
      <button class="mov-delete" data-id="${r.id}" data-action="edit" aria-label="Editar">✎</button>
      <button class="mov-delete" data-id="${r.id}" data-action="delete" aria-label="Borrar">✕</button>
    `;
    ul.appendChild(li);
  }
  ul.querySelectorAll("button[data-action=edit]").forEach(b => {
    b.addEventListener("click", () => editarLote(Number(b.dataset.id)));
  });
  ul.querySelectorAll("button[data-action=delete]").forEach(b => {
    b.addEventListener("click", () => borrarLote(Number(b.dataset.id)));
  });
}

async function editarLote(id) {
  const r = inversionesCache.find(x => x.id === id);
  if (!r) return;

  const cantStr = prompt("Cantidad (+ compra, − venta):", String(r.cantidad));
  if (cantStr === null) return;
  const cantidad = Number(cantStr);
  if (!cantidad) { alert("Cantidad inválida"); return; }

  const pArsStr = prompt("Precio ARS por unidad (vacío = null):", r.precio_ars == null ? "" : String(r.precio_ars));
  if (pArsStr === null) return;
  const precio_ars = pArsStr.trim() ? Number(pArsStr) : null;

  const pUsdStr = prompt("Precio USD por unidad (vacío = null):", r.precio_usd == null ? "" : String(r.precio_usd));
  if (pUsdStr === null) return;
  const precio_usd = pUsdStr.trim() ? Number(pUsdStr) : null;

  const mepStr = prompt("Dolar MEP del día (vacío = buscar):", r.mep == null ? "" : String(r.mep));
  if (mepStr === null) return;
  let mep = mepStr.trim() ? Number(mepStr) : null;

  const fechaActual = new Date(r.fecha).toISOString().slice(0, 10);
  const fechaStr = prompt("Fecha (YYYY-MM-DD):", fechaActual);
  if (fechaStr === null) return;

  // Si se dejó MEP vacío, buscarlo
  if (!mep) mep = await fetchMepForDate(fechaStr);

  const notas = prompt("Notas:", r.notas || "");
  if (notas === null) return;

  try {
    await sbPatchInversion(id, {
      cantidad,
      precio_ars,
      precio_usd,
      mep,
      fecha: `${fechaStr} 12:00:00-03:00`,
      notas: notas.trim() || null,
    });
    await sbFetchInversiones();
    renderTickerDetail();
  } catch (e) {
    alert("Error: " + e.message);
  }
}

async function borrarLote(id) {
  if (!confirm("¿Borrar este lote? No se puede deshacer.")) return;
  try {
    await sbDeleteInversion(id);
    inversionesCache = inversionesCache.filter(r => r.id !== id);
    renderTickerDetail();
  } catch (e) {
    alert("Error: " + e.message);
  }
}

$("btn-open-inv").addEventListener("click", openInversiones);
$("btn-inv-back").addEventListener("click", closeInversiones);
$("btn-inv-add").addEventListener("click", agregarInversion);
$("btn-inv-refresh").addEventListener("click", refreshPreciosLive);
$("btn-inv-backfill").addEventListener("click", backfillPrecios);
$("btn-td-back").addEventListener("click", closeTickerDetail);

// ==== Valor hora screen ====
const vhScreen = $("valor-hora-screen");

function mesLabel(mesISO) {
  const d = new Date(mesISO + "T12:00:00");
  return d.toLocaleDateString("es-AR", { month: "long", year: "numeric" });
}

async function openValorHoraScreen() {
  await sbFetchValoresHora();
  appScreen.classList.add("hidden");
  vhScreen.classList.remove("hidden");
  renderValorHora();
}

function closeValorHoraScreen() {
  vhScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  render(); // actualizar footer/saldo por si cambió
}

function renderValorHora() {
  $("vh-current").textContent = fmt(getValorHora());
  const ul = $("vh-list");
  ul.innerHTML = "";
  if (!valoresHoraCache.length) {
    ul.innerHTML = '<li style="justify-content:center;color:var(--muted)">Sin entradas todavía</li>';
    return;
  }
  const sorted = [...valoresHoraCache].sort((a, b) => b.mes.localeCompare(a.mes));
  for (let i = 0; i < sorted.length; i++) {
    const v = sorted[i];
    const prev = sorted[i + 1]; // siguiente en desc = mes anterior
    let pctLabel = "";
    let pctClass = "pos";
    if (prev && Number(prev.valor) > 0) {
      const pct = ((Number(v.valor) - Number(prev.valor)) / Number(prev.valor)) * 100;
      const signo = pct >= 0 ? "+" : "";
      pctLabel = `<span class="mov-meta" style="font-weight:600;color:${pct < 0 ? 'var(--danger)' : 'var(--accent)'}">${signo}${pct.toFixed(1)}%</span>`;
    }
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="mov-info">
        <div class="mov-desc">${mesLabel(v.mes)}</div>
        <div class="mov-meta">${v.mes}${pctLabel ? ' · ' + pctLabel : ''}</div>
      </div>
      <div class="mov-monto pos">${fmt(v.valor)}</div>
      <button class="mov-delete" data-mes="${v.mes}" aria-label="Editar">✎</button>
    `;
    ul.appendChild(li);
  }
  ul.querySelectorAll(".mov-delete").forEach(b => {
    b.addEventListener("click", () => editarValorMes(b.dataset.mes));
  });
}

async function editarValorMes(mes) {
  const existing = valoresHoraCache.find(v => v.mes === mes);
  const currentValor = existing ? existing.valor : 0;
  const nuevo = prompt(`Valor hora para ${mesLabel(mes)}:`, String(currentValor));
  if (nuevo === null) return;
  const n = Number(nuevo);
  if (!n || n <= 0) { alert("Valor inválido"); return; }
  if (!confirm(`Esto va a recalcular TODAS las jornadas de ${mesLabel(mes)}. ¿Confirmar?`)) return;
  try {
    const count = await sbRecalcHorasMes(mes, n);
    alert(`Actualizado. ${count} jornadas recalculadas.`);
    await sbFetchValoresHora();
    await syncFromSupabase();
    renderValorHora();
  } catch (e) {
    alert("Error: " + e.message);
  }
}

async function agregarMesValorHora() {
  const mesStr = prompt("Mes (YYYY-MM):", mesKey(new Date()).slice(0, 7));
  if (!mesStr) return;
  if (!/^\d{4}-\d{2}$/.test(mesStr)) { alert("Formato inválido, usá YYYY-MM"); return; }
  const mes = `${mesStr}-01`;
  const valor = prompt("Valor hora:", String(getValorHora()));
  if (!valor) return;
  const n = Number(valor);
  if (!n || n <= 0) { alert("Valor inválido"); return; }
  try {
    const count = await sbRecalcHorasMes(mes, n);
    alert(`Guardado. ${count} jornadas recalculadas (puede ser 0 si el mes no tiene jornadas aún).`);
    await sbFetchValoresHora();
    await syncFromSupabase();
    renderValorHora();
  } catch (e) {
    alert("Error: " + e.message);
  }
}

$("btn-open-vh").addEventListener("click", openValorHoraScreen);
$("btn-vh-back").addEventListener("click", closeValorHoraScreen);
$("btn-vh-add").addEventListener("click", agregarMesValorHora);

// ==== Movimientos collapsible ====
const movToggle = $("mov-toggle");
if (movToggle) {
  movToggle.addEventListener("click", () => {
    $("movimientos-section").classList.toggle("collapsed");
  });
}

// ==== Service Worker ====
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// ==== Version label ====
(function showVersion() {
  const el = document.getElementById("app-version");
  if (el) el.textContent = "v" + APP_VERSION;
})();

// Inicializar fechas por default a hoy
if (inputFechaMov) inputFechaMov.value = hoyISO();
if (inputFecha) inputFecha.value = hoyISO();

// ==== Boot ====
(async () => {
  // Migrar horario del control si venía de versiones anteriores (20:27, 20:30)
  const prev = localStorage.getItem(KEY_CHECK);
  if (prev === "20:27" || prev === "20:30") setCheckTime("18:00");

  const action = new URLSearchParams(location.search).get("action");
  history.replaceState({}, "", location.pathname);
  if (action === "confirmar" || action === "confirm9to18") {
    await quickConfirmar();
    return;
  }
  if (action === "editar") {
    await quickEditar();
    return;
  }
  if (action === "sueldo") {
    await quickSueldo();
    return;
  }
  if (action === "comision") {
    await quickComision();
    return;
  }

  // Si ya hay Face ID configurado, intentar desbloquear automáticamente al abrir
  showLock();
  if (localStorage.getItem(KEY_CRED)) {
    try {
      await authFaceId();
      await showApp();
    } catch (e) {
      // Falló (user canceló o iOS bloqueó por falta de activation): queda en lock screen
      lockError.textContent = "Tocá Desbloquear para reintentar.";
    }
  }
})();
