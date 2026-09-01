import { describe, expect, test } from "bun:test";
import { buildHardcopyArgs, isSafeToken, peekAgentScreen, resolvePeekTarget } from "./peek-screen";

describe("peek token safety", () => {
  test("accepts persona and ephemeral names", () => {
    expect(isSafeToken("fondant")).toBe(true);
    expect(isSafeToken("wire-bialy")).toBe(true);
    expect(isSafeToken("_ephemeral")).toBe(true);
  });

  test("rejects path/shell metacharacters", () => {
    expect(isSafeToken("fondant;rm")).toBe(false);
    expect(isSafeToken("../fondant")).toBe(false);
    expect(isSafeToken("fondant/screen")).toBe(false);
  });
});

describe("resolvePeekTarget", () => {
  test("falls back to agent id when self-report is missing", () => {
    expect(resolvePeekTarget({ id: "fondant" })).toEqual({ uid: "fondant", screenName: "fondant" });
  });

  test("uses Wire self-report columns", () => {
    expect(resolvePeekTarget({
      id: "bialy",
      run_as_uid: "_ephemeral",
      screen_name: "wire-bialy",
    })).toEqual({ uid: "_ephemeral", screenName: "wire-bialy" });
  });
});

describe("buildHardcopyArgs", () => {
  test("sudoes as the screen owner with that uid's SCREENDIR", () => {
    const { file, args } = buildHardcopyArgs({
      uid: "fondant",
      screenName: "fondant",
      tmpFile: "/tmp/wire-peek-fondant.txt",
      home: "/Users/fondant",
    });
    expect(file).toBe("sudo");
    expect(args).toEqual([
      "-n", "-u", "fondant", "-H",
      "env", "SCREENDIR=/Users/fondant/.screen",
      "/opt/homebrew/bin/screen",
      "-S", "fondant", "-X", "hardcopy", "-h",
      "/tmp/wire-peek-fondant.txt",
    ]);
  });
});

describe("peekAgentScreen", () => {
  test("returns the dump from the hardcopy file", () => {
    const calls: { file: string; args: string[] }[] = [];
    const result = peekAgentScreen(
      { id: "fondant", run_as_uid: "fondant", screen_name: "fondant" },
      {
        exec: (file, args) => {
          calls.push({ file, args });
          return Buffer.from("");
        },
        readFile: (p) => {
          expect(p).toContain("wire-peek-fondant-");
          return "live screen\n";
        },
        unlink: () => {},
        now: () => 1,
        tmpdir: "/tmp",
        settleMs: 0,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe("live screen");
      expect(calls[0]?.args.at(-1)).toMatch(/^\/tmp\/wire-peek-fondant-/);
      expect(result.run_as_uid).toBe("fondant");
      expect(result.screen_name).toBe("fondant");
    }
    expect(calls[0]?.file).toBe("sudo");
    expect(calls[0]?.args).toContain("fondant");
    expect(calls[0]?.args).toContain("SCREENDIR=/Users/fondant/.screen");
  });

  test("does not consult crews.db", () => {
    const result = peekAgentScreen(
      { id: "fondant", run_as_uid: "fondant", screen_name: "fondant" },
      {
        exec: () => Buffer.from(""),
        readFile: () => "ok",
        unlink: () => {},
        now: () => 1,
        tmpdir: "/tmp",
        settleMs: 0,
      },
    );
    expect(result.ok).toBe(true);
  });

  test("surfaces screen failure instead of a fake empty dump", () => {
    const result = peekAgentScreen(
      { id: "fondant", run_as_uid: "fondant", screen_name: "fondant" },
      {
        exec: () => {
          const e = new Error("Command failed: sudo");
          (e as any).stderr = Buffer.from("No screen session found.\n");
          throw e;
        },
        readFile: () => {
          throw new Error("should not read");
        },
        unlink: () => {},
        now: () => 1,
        tmpdir: "/tmp",
        settleMs: 0,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.detail).toContain("No screen session found");
    }
  });
});
