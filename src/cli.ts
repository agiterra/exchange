/**
 * Wire CLI dispatcher.
 *
 * The `wire` binary is multi-purpose:
 *   wire                           Start the server (default).
 *   wire serve                     Explicit server mode.
 *   wire version                   Print version.
 *   wire peer pubkey               Print this server's Ed25519 pubkey (base64).
 *   wire peer add <name> <url> <pubkey> [--notes "..."]
 *   wire peer list
 *   wire peer remove <name>
 *   wire peer update-url <name> <url>
 *
 * All `peer` subcommands operate directly on the local store — they
 * don't need the server running.
 */

import { Store } from "./store.js";
import { getServerPubkey } from "./identity.js";
import pkg from "../package.json" with { type: "json" };

const USAGE = `Wire ${pkg.version}

Usage:
  wire                                      Start the server.
  wire serve                                Start the server (explicit).
  wire version                              Print version.

  wire peer pubkey                          Print this server's pubkey.
  wire peer add <name> <url> <pubkey>       Register a peer.
      [--notes "free-form text"]
  wire peer list                            List registered peers.
  wire peer remove <name>                   Forget a peer.
  wire peer update-url <name> <url>         Re-point a peer (e.g. ngrok rotated).

Peers are paired out-of-band. To add each other:
  1. On each machine: wire peer pubkey       -> exchange the two pubkeys.
  2. On each machine: wire peer add <remote-alias> <remote-url> <remote-pubkey>
`;

type CliResult = { exit: number; stdout?: string; stderr?: string };

function parseFlags(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      flags[a.slice(2)] = args[i + 1] ?? "";
      i++;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

export async function runCli(argv: string[]): Promise<CliResult> {
  const [cmd, ...rest] = argv;

  // Default + explicit serve are handled by the caller (src/index.ts) so
  // we can keep the server startup synchronous and avoid a double
  // deps graph. The CLI only handles non-serve commands.
  if (!cmd || cmd === "serve") {
    return { exit: -1 }; // sentinel: caller should start the server
  }
  if (cmd === "-h" || cmd === "--help") return { exit: 0, stdout: USAGE };
  if (cmd === "version" || cmd === "--version") return { exit: 0, stdout: `${pkg.version}\n` };

  if (cmd === "peer") {
    return runPeerCli(rest);
  }
  return { exit: 1, stderr: `unknown command: ${cmd}\n\n${USAGE}` };
}

async function runPeerCli(args: string[]): Promise<CliResult> {
  const [sub, ...rest] = args;
  if (!sub) return { exit: 1, stderr: `peer: subcommand required\n\n${USAGE}` };

  if (sub === "pubkey") {
    const pubkey = await getServerPubkey();
    return { exit: 0, stdout: `${pubkey}\n` };
  }

  // Remaining subcommands touch the store. Open it lazily.
  const store = new Store();
  try {
    switch (sub) {
      case "add": {
        const { flags, positional } = parseFlags(rest);
        const [name, url, pubkey] = positional;
        if (!name || !url || !pubkey) {
          return { exit: 1, stderr: "peer add: requires <name> <url> <pubkey>\n" };
        }
        if (store.getPeer(name)) return { exit: 1, stderr: `peer '${name}' already registered\n` };
        const peer = store.createPeer({ name, base_url: url, pubkey, notes: flags.notes });
        return { exit: 0, stdout: `${JSON.stringify(peer)}\n` };
      }
      case "list":
        return { exit: 0, stdout: `${JSON.stringify(store.listPeers(), null, 2)}\n` };
      case "remove": {
        const [name] = rest;
        if (!name) return { exit: 1, stderr: "peer remove: requires <name>\n" };
        if (!store.getPeer(name)) return { exit: 1, stderr: `peer '${name}' not found\n` };
        store.deletePeer(name);
        return { exit: 0, stdout: `${JSON.stringify({ removed: name })}\n` };
      }
      case "update-url": {
        const [name, url] = rest;
        if (!name || !url) return { exit: 1, stderr: "peer update-url: requires <name> <url>\n" };
        if (!store.getPeer(name)) return { exit: 1, stderr: `peer '${name}' not found\n` };
        store.updatePeerUrl(name, url);
        return { exit: 0, stdout: `${JSON.stringify(store.getPeer(name))}\n` };
      }
      default:
        return { exit: 1, stderr: `peer: unknown subcommand '${sub}'\n\n${USAGE}` };
    }
  } finally {
    store.close();
  }
}
