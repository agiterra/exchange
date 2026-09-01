/**
 * Operator peek: dump an agent's GNU screen via sudo-as-uid + SCREENDIR.
 *
 * The previous handler read tim's crews.db (ephemeral crew names) and ran
 * `screen -X hardcopy` as the Wire uid (tim), so personae 404'd and engineer
 * peeks hit the wrong socket dir. Wire self-report (run_as_uid / screen_name)
 * is the deciding surface; sudo -n -u <uid> -H env SCREENDIR=$HOME/.screen
 * is the proven live path.
 */
import { execFileSync } from "child_process";
import { readFileSync, unlinkSync } from "fs";
import { join } from "path";

const SAFE = /^[A-Za-z0-9_.-]+$/;
const SCREEN_BIN = "/opt/homebrew/bin/screen";
const MAX_OUTPUT = 200_000;

export type PeekAgent = {
  id: string;
  run_as_uid?: string | null;
  screen_name?: string | null;
};

export type PeekOk = {
  ok: true;
  agent_id: string;
  screen_name: string;
  run_as_uid: string;
  output: string;
};

export type PeekErr = {
  ok: false;
  status: number;
  error: string;
  detail?: string;
};

export type PeekResult = PeekOk | PeekErr;

export type PeekExec = (file: string, args: string[], opts?: { timeout?: number }) => Buffer;

export function isSafeToken(value: string): boolean {
  return SAFE.test(value);
}

export function defaultHomeForUid(uid: string): string {
  return `/Users/${uid}`;
}

export function resolvePeekTarget(agent: PeekAgent): { uid: string; screenName: string } | PeekErr {
  if (!isSafeToken(agent.id)) {
    return { ok: false, status: 400, error: `unsafe agent id '${agent.id}'` };
  }
  const uid = agent.run_as_uid || agent.id;
  const screenName = agent.screen_name || agent.id;
  if (!isSafeToken(uid)) {
    return { ok: false, status: 400, error: `unsafe run_as_uid '${uid}'` };
  }
  if (!isSafeToken(screenName)) {
    return { ok: false, status: 400, error: `unsafe screen_name '${screenName}'` };
  }
  return { uid, screenName };
}

export function buildHardcopyArgs(opts: {
  uid: string;
  screenName: string;
  tmpFile: string;
  home: string;
}): { file: string; args: string[] } {
  return {
    file: "sudo",
    args: [
      "-n",
      "-u",
      opts.uid,
      "-H",
      "env",
      `SCREENDIR=${join(opts.home, ".screen")}`,
      SCREEN_BIN,
      "-S",
      opts.screenName,
      "-X",
      "hardcopy",
      "-h",
      opts.tmpFile,
    ],
  };
}

function execErrorDetail(e: unknown): string {
  if (!e || typeof e !== "object") return String(e);
  const err = e as { message?: string; stderr?: Buffer | string; stdout?: Buffer | string };
  const stderr = err.stderr ? err.stderr.toString() : "";
  return [err.message, stderr].filter(Boolean).join(" — ");
}

export function peekAgentScreen(
  agent: PeekAgent,
  deps: {
    exec?: PeekExec;
    homeForUid?: (uid: string) => string;
    readFile?: (p: string) => string;
    unlink?: (p: string) => void;
    now?: () => number;
    tmpdir?: string;
    settleMs?: number;
    sleep?: (ms: number) => void;
  } = {},
): PeekResult {
  const resolved = resolvePeekTarget(agent);
  if ("ok" in resolved) return resolved;

  const { uid, screenName } = resolved;
  const exec = deps.exec ?? ((file, args, opts) =>
    execFileSync(file, args, { timeout: opts?.timeout ?? 5000, stdio: ["ignore", "pipe", "pipe"] }));
  const homeForUid = deps.homeForUid ?? defaultHomeForUid;
  const readFile = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
  const unlink = deps.unlink ?? ((p) => unlinkSync(p));
  const now = deps.now ?? Date.now;
  // /tmp is world-writable. os.tmpdir() under launchd is tim's private
  // TMPDIR (/var/folders/.../T), which the screen owner cannot write.
  const dir = deps.tmpdir ?? "/tmp";
  const sleep = deps.sleep ?? ((ms) => {
    if (ms <= 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  });

  const tmpFile = join(dir, `wire-peek-${agent.id}-${now()}.txt`);
  const { file, args } = buildHardcopyArgs({
    uid,
    screenName,
    tmpFile,
    home: homeForUid(uid),
  });

  try {
    exec(file, args, { timeout: 5000 });
  } catch (e) {
    return {
      ok: false,
      status: 500,
      error: `failed to read screen for '${agent.id}' (uid=${uid} screen=${screenName})`,
      detail: execErrorDetail(e),
    };
  }

  const settleMs = deps.settleMs ?? 150;
  if (settleMs > 0) sleep(settleMs);

  let text = "";
  try {
    text = readFile(tmpFile);
  } catch (e) {
    try {
      text = exec("sudo", ["-n", "cat", tmpFile], { timeout: 3000 }).toString("utf8");
    } catch (e2) {
      return {
        ok: false,
        status: 500,
        error: `hardcopy produced no readable dump for '${agent.id}'`,
        detail: execErrorDetail(e2),
      };
    }
  }

  try { unlink(tmpFile); } catch { /* leftover in /tmp is nonfatal */ }

  if (text.length > MAX_OUTPUT) {
    text = text.slice(-MAX_OUTPUT);
  }

  return {
    ok: true,
    agent_id: agent.id,
    screen_name: screenName,
    run_as_uid: uid,
    output: text.replace(/\s+$/, ""),
  };
}
