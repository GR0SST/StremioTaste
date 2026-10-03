const base = document.documentElement.dataset.base || "";
const $ = (id) => document.getElementById(id);
let current = null,
  polling = null,
  busy = false,
  deviceTimer = null;
function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}
async function api(path, method = "GET", data) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}
function provider() {
  return document.querySelector('input[name="provider"]:checked').value;
}

const openaiModels = [
  ["Luna", "gpt-6-luna"],
  ["Terra", "gpt-5.6-terra"],
  ["Sol", "gpt-6.1-sol"],
  ["Astra", "gpt-6-astra"],
];
const modelPresets = {
  openai: openaiModels,
  openrouter: [
    ...openaiModels.map(([name, id]) => [name, "openai/" + id]),
    ["Sonnet 5.5", "anthropic/claude-sonnet-5.5"],
    ["Opus 5.5", "anthropic/claude-opus-5.5"],
    ["Gemini 3.8 Flash", "google/gemini-3.8-flash"],
  ],
};
const modelDrafts = {};
let modelProvider = provider();
function selectedModel() {
  return $("model").value === "custom"
    ? $("custom-model").value.trim()
    : $("model").value;
}
function toggleCustomModel() {
  const custom = $("model").value === "custom";
  $("custom-model-field").hidden = !custom;
  $("custom-model").disabled = !custom;
  $("custom-model").required = custom;
}
function populateModels(savedModel) {
  const choices = modelPresets[provider()];
  $("model").replaceChildren(
    ...choices.map(([name, id]) => new Option(name, id)),
    new Option("Custom", "custom"),
  );
  const value = savedModel ?? choices[0][1];
  const preset = choices.some(([, id]) => id === value);
  $("model").value = preset ? value : "custom";
  $("custom-model").value = preset ? "" : value;
  modelProvider = provider();
  toggleCustomModel();
}
populateModels();
$("model").addEventListener("change", toggleCustomModel);

function keyHint() {
  const saved = current?.configured && current.settings.provider === provider();
  $("api-key").required = !saved;
  $("api-key").placeholder = saved ? "Saved key" : "API key";
}
function renderPosters(metas) {
  $("posters").replaceChildren();
  for (const meta of metas.slice(0, 10)) {
    const article = document.createElement("article");
    article.className = "poster";
    const img = document.createElement("img");
    img.src = meta.poster;
    img.alt = meta.name;
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    const title = document.createElement("h3");
    title.textContent = meta.name;
    const reason = document.createElement("p");
    reason.textContent = meta.description?.split("\n\n")[0] || "";
    article.append(img, title, reason);
    $("posters").append(article);
  }
}
async function load(fill = false) {
  const data = await api("/api/status");
  const changed = data.cachedAt !== current?.cachedAt;
  current = data;
  $("server-notice").hidden = data.serverReady;
  $("invite-label").hidden = !data.inviteRequired || data.connected;
  $("connect").disabled = !data.serverReady || data.running || busy;
  $("connect").textContent = data.connected
    ? "Reconnect Trakt ↗"
    : "Connect Trakt ↗";
  $("trakt-badge").textContent = data.connected ? "Connected" : "Not connected";
  $("trakt-badge").classList.toggle("connected", data.connected);
  $("settings-fields").disabled = !data.connected || data.running || busy;
  $("installation").hidden = !data.manifestUrl;
  $("delete-profile").hidden = !data.connected;
  $("delete-profile").disabled = data.running || busy;
  $("results").hidden = !data.configured;
  $("refresh").disabled =
    data.running || busy || (data.retryAt && data.retryAt > Date.now());
  $("refresh").textContent = data.running ? "Generating…" : "Refresh";
  if (data.manifestUrl) {
    $("manifest-url").value = data.manifestUrl;
    $("install").href = data.manifestUrl.replace(/^https?:/, "stremio:");
  }
  if (fill && data.settings) {
    document.querySelector(
      `input[name="provider"][value="${data.settings.provider}"]`,
    ).checked = true;
    populateModels(data.settings.model);
    $("language").value = data.settings.language;
    document.querySelectorAll('input[name="catalogs"]').forEach((input) => {
      input.checked = data.settings.catalogs.includes(input.value);
    });
  }
  keyHint();
  if (changed || fill) renderPosters(data.metas);
  $("updated").textContent = data.cachedAt
    ? `Updated ${new Date(data.cachedAt).toLocaleString("en-US")} · ${data.metas.length} picks`
    : "No picks yet.";
  if (data.running) status("Generating picks…");
  else if (data.error) status(data.error, true);
  else if (polling && data.cachedAt) status("Picks ready.");
  clearTimeout(polling);
  polling = data.running
    ? setTimeout(
        () =>
          load().catch((error) => {
            status(error.message, true);
            polling = null;
          }),
        3000,
      )
    : null;
}
$("connect").addEventListener("click", async () => {
  $("connect").disabled = true;
  try {
    const result = await api("/api/trakt/connect", "POST", {
      inviteCode: $("invite").value,
    });
    if (result.url) {
      location.assign(result.url);
      return;
    }
    clearTimeout(deviceTimer);
    $("device").hidden = false;
    $("device-code").textContent = result.device.userCode;
    $("device-link").href = result.device.verificationUrl;
    status("Waiting for Trakt…");
    const poll = async () => {
      try {
        if (Date.now() > result.device.expiresAt)
          throw new Error("Code expired. Reconnect Trakt.");
        const check = await api("/api/trakt/poll", "POST");
        if (check.connected) {
          $("device").hidden = true;
          status("Trakt connected.");
          await load(true);
          return;
        }
        deviceTimer = setTimeout(
          poll,
          check.interval || result.device.interval,
        );
      } catch (error) {
        status(error.message, true);
        $("connect").disabled = false;
      }
    };
    deviceTimer = setTimeout(poll, result.device.interval);
  } catch (error) {
    status(error.message, true);
    $("connect").disabled = false;
  }
});
document.querySelectorAll('input[name="provider"]').forEach((input) =>
  input.addEventListener("change", () => {
    modelDrafts[modelProvider] = selectedModel();
    populateModels(
      modelDrafts[provider()] ??
        (current?.settings?.provider === provider()
          ? current.settings.model
          : undefined),
    );
    $("api-key").value = "";
    keyHint();
  }),
);
$("settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = {
    provider: provider(),
    apiKey: $("api-key").value.trim(),
    model: selectedModel(),
    language: $("language").value,
    catalogs: [
      ...document.querySelectorAll('input[name="catalogs"]:checked'),
    ].map((input) => input.value),
  };
  if (!input.catalogs.length)
    return status("Select at least one catalog.", true);
  busy = true;
  $("settings-fields").disabled = true;
  try {
    await api("/api/settings", "POST", input);
    $("api-key").value = "";
    status("Generating picks…");
    await api("/api/refresh", "POST");
  } catch (error) {
    status(error.message, true);
  } finally {
    busy = false;
    await load().catch((error) => status(error.message, true));
  }
});
$("refresh").addEventListener("click", async () => {
  $("refresh").disabled = true;
  try {
    await api("/api/refresh", "POST");
    await load();
  } catch (error) {
    status(error.message, true);
    $("refresh").disabled = false;
  }
});
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("manifest-url").value);
    status("URL copied.");
  } catch {
    $("manifest-url").select();
    status("Copy the selected URL.");
  }
});
$("delete-profile").addEventListener("click", async () => {
  if (!confirm("Delete your profile and deactivate its install URL?")) return;
  try {
    await api("/api/profile", "DELETE");
    location.assign(`${base}/configure`);
  } catch (error) {
    status(error.message, true);
  }
});
const auth = new URLSearchParams(location.search).get("auth");
if (auth) {
  status(
    auth === "connected"
      ? "Trakt connected."
      : "Trakt connection failed. Try again.",
    auth !== "connected",
  );
  history.replaceState(null, "", `${base}/configure`);
}
load(true).catch((error) => status(error.message, true));
setInterval(() => {
  if (current && !current.running && !busy && current.retryAt < Date.now())
    $("refresh").disabled = false;
}, 1000);
