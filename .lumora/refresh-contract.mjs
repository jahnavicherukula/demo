#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

const BEGIN = "<!-- Lumora MCP instructions -->";
const END = "<!-- /Lumora MCP instructions -->";
const TIMEOUT_MS = 4500;

function softFail(message) {
  try { process.stderr.write(`[lumora-setup] ${message}\n`); } catch { /* ignore */ }
  process.stdout.write("{}");
  process.exit(0);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function wrapManaged(body) {
  const without = String(body || "").trim()
    .replace(new RegExp("^" + BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*"), "")
    .replace(new RegExp("\\s*" + END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"), "")
    .trim();
  return BEGIN + "\n" + without + "\n" + END + "\n";
}

function patchManaged(existing, body) {
  const section = wrapManaged(body);
  if (!existing || !existing.includes(BEGIN)) {
    return (existing && existing.trim() ? existing.trimEnd() + "\n\n" : "") + section;
  }
  const beginIdx = existing.indexOf(BEGIN);
  const endIdx = existing.indexOf(END, beginIdx);
  if (endIdx >= 0) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + END.length).replace(/^\r?\n/, "");
    return before + section + after;
  }
  return existing.slice(0, beginIdx) + section;
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + "." + process.pid + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

function windowsPath(account) {
  const root = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(root, "lumora", "credentials", Buffer.from(account).toString("base64url") + ".credential.xml");
}

function readCredential(account) {
  if (platform() === "darwin") {
    return execFileSync("security", ["find-generic-password", "-s", "lumora", "-a", account, "-w"], { encoding: "utf8" }).trim();
  }
  if (platform() === "linux") {
    return execFileSync("secret-tool", ["lookup", "service", "lumora", "account", account], { encoding: "utf8" }).trim();
  }
  if (platform() === "win32") {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$c=Import-Clixml -LiteralPath $env:LUMORA_CREDENTIAL_PATH;[Console]::Out.Write($c.GetNetworkCredential().Password)"], {
      encoding: "utf8",
      env: { ...process.env, LUMORA_CREDENTIAL_PATH: windowsPath(account) },
    });
  }
  throw new Error("unsupported platform");
}

function resolveRef(ref) {
  if (ref.kind === "env") {
    const value = process.env[ref.name];
    if (!value) throw new Error("missing env " + ref.name);
    return value;
  }
  return readCredential(ref.account || ref.ref);
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const repoRoot = process.cwd();
  const configPath = join(repoRoot, ".lumora", "config.json");
  if (!existsSync(configPath)) softFail("missing .lumora/config.json — re-run npx lumora-setup");
  let config;
  try { config = readJson(configPath); } catch { softFail("invalid .lumora/config.json — re-run npx lumora-setup"); }

  const serverUrl = String(config.serverUrl || "").replace(/\/$/, "");
  const organizationId = config.organizationId;
  const refreshRef = config.refreshTokenRef;
  const clientId = config.oauthClientId;
  if (!serverUrl || !organizationId || !refreshRef || !clientId) {
    softFail("incomplete Lumora setup state — re-run npx lumora-setup");
  }

  let refreshToken;
  try { refreshToken = resolveRef(refreshRef); } catch { softFail("could not read refresh token — re-run npx lumora-setup"); }

  let tokenRes;
  try {
    tokenRes = await fetchWithTimeout(serverUrl + "/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
      }),
    });
  } catch {
    softFail("network error refreshing MCP token");
  }
  if (!tokenRes.ok) softFail("auth expired — re-run npx lumora-setup");
  const tokens = await tokenRes.json();
  if (!tokens.access_token) softFail("auth expired — re-run npx lumora-setup");
  if (tokens.refresh_token && refreshRef.kind === "keychain") {
    try {
      const account = refreshRef.account || refreshRef.ref;
      if (platform() === "darwin") {
        try { execFileSync("security", ["delete-generic-password", "-s", "lumora", "-a", account], { stdio: "ignore" }); } catch {}
        execFileSync("security", ["add-generic-password", "-s", "lumora", "-a", account, "-w", tokens.refresh_token], { stdio: ["ignore", "ignore", "pipe"] });
      } else if (platform() === "linux") {
        execFileSync("secret-tool", ["store", "--label=lumora", "service", "lumora", "account", account], { input: tokens.refresh_token, stdio: ["pipe", "ignore", "pipe"] });
      }
      // ponytail: windows refresh persistence in hook deferred; setup re-run recovers
    } catch { /* keep previous refresh; may fail next time */ }
  }

  let contractRes;
  try {
    contractRes = await fetchWithTimeout(
      serverUrl + "/api/v1/mcp/org/" + encodeURIComponent(organizationId) + "/agent-contract",
      { headers: { authorization: "Bearer " + tokens.access_token, accept: "application/json" } },
    );
  } catch {
    softFail("network error fetching agent contract");
  }
  if (!contractRes.ok) softFail("could not fetch agent contract");
  const contract = await contractRes.json();
  const agentsMd = contract.agentsMd || contract.data?.agentsMd;
  const claudeMd = contract.claudeMd || contract.data?.claudeMd;
  if (!agentsMd || !claudeMd) softFail("agent contract response incomplete");

  for (const [name, body] of [["AGENTS.md", agentsMd], ["CLAUDE.md", claudeMd]]) {
    const path = join(repoRoot, name);
    let existing = "";
    try { existing = readFileSync(path, "utf8"); } catch { existing = ""; }
    atomicWrite(path, patchManaged(existing, body));
  }
  process.stdout.write("{}");
}

main().catch((error) => softFail(error instanceof Error ? error.message : String(error)));
