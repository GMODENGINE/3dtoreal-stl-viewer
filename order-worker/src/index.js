/* Copyright (c) 2026 ИП Ильин А. · SPDX-License-Identifier: AGPL-3.0-only */
const ALLOWED_ORIGINS = new Set([
  "https://3dtoreal.ru",
  "https://www.3dtoreal.ru",
]);

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 512 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOWED_EXTENSIONS = new Set(["stl", "obj", "glb", "3mf", "step", "stp"]);
const ALLOWED_FORMATS_LABEL = "STL, OBJ, GLB, 3MF, STEP или STP";
const ORDER_PATTERN = /^DTTR-\d{8}-[A-Z0-9]{5}$/;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function json(data, status = 200, origin = "") {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  addCors(headers, origin);
  return new Response(JSON.stringify(data), { status, headers });
}

function addCors(headers, origin) {
  if (!ALLOWED_ORIGINS.has(origin)) return;
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Accept, Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin");
}

function clean(value, maxLength) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newOrderNumber() {
  const now = new Date();
  const date = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  ].join("");
  return `DTTR-${date}-${randomHex(4).slice(0, 5).toUpperCase()}`;
}

function safeFileName(name) {
  const cleaned = clean(name, 180).replace(/[\\/]/g, "-");
  return cleaned || "model.stl";
}

function extensionOf(name) {
  return name.includes(".") ? name.split(".").pop().toLowerCase() : "";
}

function attachmentHeader(fileName) {
  const fallback = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "model.stl";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

async function createOrder(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return json({ success: false, message: "Недопустимый источник запроса." }, 403, origin);
  }

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return json({ success: false, message: "Неверный формат заявки." }, 415, origin);
  }
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    return json({ success: false, message: "Файл больше 10 МБ. Отправьте его напрямую на почту." }, 413, origin);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ success: false, message: "Не удалось прочитать данные заявки." }, 400, origin);
  }

  if (clean(form.get("website"), 120)) {
    return json({ success: true, orderNumber: newOrderNumber() }, 200, origin);
  }

  const suppliedOrderNumber = clean(form.get("order_number"), 40).toUpperCase();
  const orderNumber = ORDER_PATTERN.test(suppliedOrderNumber) ? suppliedOrderNumber : newOrderNumber();
  const name = clean(form.get("customer_name"), 120);
  const phone = clean(form.get("customer_phone"), 80);
  const email = clean(form.get("customer_email"), 180);
  const comment = clean(form.get("customer_comment"), 2000);
  const details = clean(form.get("order_details"), 12000);
  const pageUrl = clean(form.get("page_url"), 500) || "https://3dtoreal.ru/stlviewer";
  const largeFile = form.get("large_file") === "1";

  if (!name || (!phone && !email) || !details || form.get("consent") !== "yes") {
    return json({ success: false, message: "Заполните обязательные поля и подтвердите согласие." }, 422, origin);
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ success: false, message: "Проверьте адрес электронной почты." }, 422, origin);
  }

  let key = "";
  let downloadToken = "";
  let fileName = clean(form.get("file_name"), 180) || "Файл больше 10 МБ";
  let downloadUrl = "";
  let expiresAt = "";

  if (!largeFile) {
    const file = form.get("attachment");
    if (!(file instanceof File) || file.size === 0) {
      return json({ success: false, message: `Приложите ${ALLOWED_FORMATS_LABEL}-файл.` }, 422, origin);
    }
    if (file.size > MAX_FILE_BYTES) {
      return json({ success: false, message: "Файл больше 10 МБ. Отправьте его напрямую на почту." }, 413, origin);
    }
    fileName = safeFileName(file.name);
    if (!ALLOWED_EXTENSIONS.has(extensionOf(fileName))) {
      return json({ success: false, message: `Можно отправить только ${ALLOWED_FORMATS_LABEL}-файл.` }, 415, origin);
    }

    downloadToken = randomHex(32);
    key = `orders/${downloadToken}`;
    expiresAt = new Date(Date.now() + RETENTION_MS).toISOString();
    downloadUrl = `${new URL(request.url).origin}/file/${downloadToken}`;
    await env.ORDER_FILES.put(key, file.stream(), {
      expirationTtl: Math.floor(RETENTION_MS / 1000),
      metadata: {
        fileName,
        orderNumber,
        expiresAt,
        size: String(file.size),
      },
    });
  }

  log("order_file_ready", { orderNumber, largeFile, hasFile: Boolean(key) });
  return json({ success: true, orderNumber, largeFile, downloadUrl, downloadToken, expiresAt }, 200, origin);
}

async function cancelOrder(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return json({ success: false, message: "Недопустимый источник запроса." }, 403, origin);
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ success: false, message: "Неверный формат запроса." }, 400, origin);
  }
  const token = clean(form.get("download_token"), 80);
  if (!TOKEN_PATTERN.test(token)) return json({ success: false, message: "Неверный идентификатор файла." }, 422, origin);
  await env.ORDER_FILES.delete(`orders/${token}`);
  log("order_file_cancelled");
  return json({ success: true }, 200, origin);
}

async function downloadFile(request, env, token) {
  if (!TOKEN_PATTERN.test(token)) return new Response("Файл не найден", { status: 404 });
  const object = await env.ORDER_FILES.getWithMetadata(`orders/${token}`, { type: "stream" });
  if (!object.value) return new Response("Файл не найден или срок ссылки истёк", { status: 404 });

  const expiresAt = Date.parse(object.metadata?.expiresAt || "");
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await env.ORDER_FILES.delete(`orders/${token}`);
    return new Response("Срок ссылки истёк", { status: 410 });
  }

  const fileName = safeFileName(object.metadata?.fileName || "model.stl");
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": attachmentHeader(fileName),
    "Content-Length": String(object.metadata?.size || ""),
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Referrer-Policy": "no-referrer",
  });
  if (!headers.get("Content-Length")) headers.delete("Content-Length");
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(object.value, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    try {
      if (request.method === "OPTIONS" && (url.pathname === "/order" || url.pathname === "/cancel")) {
        if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
        const headers = new Headers();
        addCors(headers, origin);
        return new Response(null, { status: 204, headers });
      }
      if (request.method === "POST" && url.pathname === "/order") return createOrder(request, env);
      if (request.method === "POST" && url.pathname === "/cancel") return cancelOrder(request, env);
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/file/")) {
        return downloadFile(request, env, url.pathname.slice(6));
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "dttr-order-api" });
      }
      return json({ success: false, message: "Маршрут не найден." }, 404, origin);
    } catch (error) {
      log("request_failed", { method: request.method, path: url.pathname, message: String(error?.message || error) });
      return json({ success: false, message: "Временная ошибка сервиса. Попробуйте ещё раз." }, 500, origin);
    }
  },
};
